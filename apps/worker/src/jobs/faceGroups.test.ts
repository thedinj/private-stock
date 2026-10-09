import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    EMBED_DIMS,
    FACE_GROUPS_REL_PATH,
    encodeVectorFile,
    faceFileRelPath,
    normaliseVector,
    quantize,
} from "@private-stock/core";

/**
 * Gathering faces of one person across the library (§5f "Grouping"): people within an item first,
 * then placed among the library's groups, a passer-by in no group, and only new faces read on the
 * next run. Real faces files in a temporary data directory; the rows are stood in for.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "ps-facegroups-"));

const state = vi.hoisted(() => ({
    items: [] as { mediaId: string; kind: "video" | "image"; last: number; faces: string[] }[],
    groups: new Map<string, string | null>(),
    cleared: 0,
    dissolved: [] as string[],
    stats: null as { groupId: string; cohesion: number }[] | null,
}));

vi.mock("@private-stock/db", () => ({
    db: {},
    faceRepo: {
        itemsToGroup: (cursor: number, limit: number) =>
            state.items.filter((item) => item.last > cursor).slice(0, limit),
        facesToGroup: (mediaId: string) =>
            state.items
                .find((item) => item.mediaId === mediaId)!
                .faces.map((id, vectorIndex) => ({ id, vectorIndex })),
        applyGroups: (
            assigned: { id: string; groupId: string | null }[],
            merged: { from: string; to: string }[]
        ) => {
            for (const { from, to } of merged) {
                for (const [id, group] of state.groups)
                    if (group === from) state.groups.set(id, to);
            }
            for (const { id, groupId } of assigned) state.groups.set(id, groupId);
        },
        clearGroups: () => {
            state.cleared += 1;
            state.groups.clear();
        },
        dissolvedGroups: () => state.dissolved,
        forgetDissolved: (ids: string[]) => {
            state.dissolved = state.dissolved.filter((id) => !ids.includes(id));
        },
        hasGroupStats: () => state.stats !== null,
        replaceGroupStats: (rows: { groupId: string; cohesion: number }[]) => {
            state.stats = rows;
        },
    },
}));

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
}));

vi.mock("../queue.js", () => ({ enqueue: vi.fn() }));

const anchorsQueued = vi.hoisted(() => vi.fn());

vi.mock("./faceAnchors.js", () => ({ enqueueFaceAnchors: anchorsQueued }));
vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { runFaceGroups } = await import("./faceGroups.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Somebody's face: mostly one axis, with a little of another so no two are identical. */
const faceOf = (who: number, wobble: number): Float32Array => {
    const vector = new Float32Array(EMBED_DIMS);

    vector[who] = 1;
    vector[100 + wobble] = 0.2;

    return normaliseVector(vector);
};

const writeFaces = (mediaId: string, vectors: Float32Array[]): void => {
    const file = path.join(dataDir, faceFileRelPath(mediaId));

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
        file,
        encodeVectorFile({
            model: "face-rec-arcface-r50",
            stageVersion: 1,
            dims: EMBED_DIMS,
            vectors: vectors.map((vector) => ({ atMs: 0, square: 0, vector: quantize(vector) })),
            representatives: [],
        })
    );
};

const add = (mediaId: string, kind: "video" | "image", faces: Float32Array[]): void => {
    writeFaces(mediaId, faces);
    state.items.push({
        mediaId,
        kind,
        last: state.items.length + 1,
        faces: faces.map((_, i) => `${mediaId}-${i}`),
    });
};

beforeEach(() => {
    anchorsQueued.mockClear();
    state.items.length = 0;
    state.groups.clear();
    state.cleared = 0;
    state.dissolved = [];
    state.stats = null;
    rmSync(path.join(dataDir, FACE_GROUPS_REL_PATH), { force: true });
});

describe("grouping faces", () => {
    it("gathers one person across items, and leaves a passer-by in no group", async () => {
        add("item-a", "video", [faceOf(1, 1), faceOf(1, 2)]);
        add("item-b", "video", [faceOf(1, 3), faceOf(1, 4), faceOf(7, 5)]);
        add("item-c", "image", [faceOf(7, 6)]);

        await runFaceGroups();

        const group = (id: string) => state.groups.get(id);

        expect(group("item-a-0")).toBeTruthy();
        expect(group("item-a-1")).toBe(group("item-a-0"));
        expect(group("item-b-0")).toBe(group("item-a-0"));
        expect(group("item-b-1")).toBe(group("item-a-0"));
        // Seen once in a video: nobody to group.
        expect(group("item-b-2")).toBeNull();
        // A photograph is one picture, so one face of somebody is all there will ever be.
        expect(group("item-c-0")).toBeTruthy();
        expect(group("item-c-0")).not.toBe(group("item-a-0"));
    });

    it("reads only what arrived since the last run, and joins it to the groups it kept", async () => {
        add("item-a", "video", [faceOf(1, 1), faceOf(1, 2)]);
        await runFaceGroups();

        const first = state.groups.get("item-a-0");

        add("item-d", "video", [faceOf(1, 7), faceOf(1, 8)]);
        state.groups.set("item-a-0", "not touched again");
        await runFaceGroups();

        expect(state.groups.get("item-d-0")).toBe(first);
        expect(state.groups.get("item-a-0")).toBe("not touched again");
        expect(state.cleared).toBe(1);
    });

    it("queues the face references after a run that grouped something, and only then", async () => {
        add("item-a", "video", [faceOf(1, 1), faceOf(1, 2)]);
        await runFaceGroups();

        expect(anchorsQueued).toHaveBeenCalledTimes(1);

        await runFaceGroups();

        expect(anchorsQueued).toHaveBeenCalledTimes(1);
    });

    it("drops a dissolved group from its sums, so a new face starts a group of its own", async () => {
        add("item-a", "video", [faceOf(1, 1), faceOf(1, 2)]);
        await runFaceGroups();

        const first = state.groups.get("item-a-0")!;

        expect(state.stats?.map((row) => row.groupId)).toEqual([first]);
        expect(state.stats?.[0].cohesion).toBeGreaterThan(0.9);

        state.dissolved = [first];
        add("item-b", "video", [faceOf(1, 3), faceOf(1, 4)]);
        await runFaceGroups();

        expect(state.groups.get("item-b-0")).not.toBe(first);
        expect(state.dissolved).toEqual([]);
        expect(state.stats?.map((row) => row.groupId)).not.toContain(first);
    });

    it("starts again from every face when the groups file is lost", async () => {
        add("item-a", "video", [faceOf(1, 1), faceOf(1, 2)]);
        await runFaceGroups();
        rmSync(path.join(dataDir, FACE_GROUPS_REL_PATH));

        await runFaceGroups();

        expect(state.cleared).toBe(2);
        expect(state.groups.get("item-a-0")).toBeTruthy();
    });
});
