import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    EMBED_DIMS,
    FACE_ANCHORS_REL_PATH,
    decodeFaceAnchors,
    encodeVectorFile,
    faceFileRelPath,
    normaliseVector,
    quantize,
} from "@private-stock/core";

/**
 * Every performer's face reference, and every face's best match (§5f "One face, one score"): from
 * confirmations, from the face their tagged items share, and never a reference of one item.
 * Real faces files in a temporary data directory; the rows are stood in for.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "ps-faceanchors-"));

const state = vi.hoisted(() => ({
    decisions: [] as unknown[],
    appearances: [] as {
        mediaId: string;
        faceIds: string[];
        matchTagId: string | null;
        score: number | null;
    }[],
    confirmed: [] as { tagId: string; mediaId: string; vectorIndex: number }[],
    tagged: [] as { tagId: string; faceId: string; mediaId: string; vectorIndex: number }[],
    faces: [] as { id: string; mediaId: string; vectorIndex: number }[],
    candidates: [] as Record<string, unknown>[],
    counts: { proposed: 0, right: 0, wrong: 0, applied: 0, removed: 0 },
    setting: {} as Record<string, unknown>,
    decided: [] as string[][],
    batches: [] as { assignments: unknown[]; source: string; userId: string }[],
    written: null as null | {
        anchors: { tagId: string; items: number; confirmedItems: number; sharedItems: number }[];
        matches: { faceId: string; tagId: string; score: number; second: number }[];
    },
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    // A press runs its writes, as one decision (§5f "Decisions you can take back").
    faceDecisionRepo: {
        record: (decision: unknown, write: () => unknown) => {
            state.decisions.push(decision);
            return { decisionId: "d1", result: write() };
        },
    },
    faceAutoTagRepo: {
        candidates: () => state.candidates,
        replaceProposals: () => undefined,
        counts: () => state.counts,
        decide: (mediaId: string, tagId: string, verdict: string) =>
            state.decided.push([mediaId, tagId, verdict]),
    },
    settingRepo: { get: () => state.setting },
    tagRepo: { findById: (id: string) => ({ id, name: id }) },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: unknown[]; source: string; userId: string }) => {
            state.batches.push(input);
            return { batchId: "b", assigned: input.assignments.length };
        },
    },
    searchRepo: { requestReindex: () => undefined },
    appearanceRepo: {
        sourceFaces: () =>
            state.faces.map((face) => ({
                ...face,
                eyes: 30,
                score: 0.9,
                kind: "video",
                scattered: 0,
            })),
        replaceAll: (rows: typeof state.appearances) => {
            state.appearances = [...rows];
        },
    },
    changeLogRepo: { recordMany: () => undefined },
    faceRepo: {
        confirmedFaceRefs: () => state.confirmed,
        taggedFaceRefs: () => state.tagged,
        replaceAnchors: (
            anchors: NonNullable<typeof state.written>["anchors"],
            matches: NonNullable<typeof state.written>["matches"]
        ) => {
            state.written = { anchors, matches };
        },
    },
}));

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
}));

vi.mock("../queue.js", () => ({ enqueue: vi.fn() }));
vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { runFaceAnchors } = await import("./faceAnchors.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Somebody's face: mostly one axis, with a little of another so no two are identical. */
const faceOf = (who: number, wobble: number): Float32Array => {
    const vector = new Float32Array(EMBED_DIMS);

    vector[who] = 1;
    vector[100 + wobble] = 0.2;

    return normaliseVector(vector);
};

/** An item with these people's faces, written to disk and registered. */
const item = (mediaId: string, people: number[]): void => {
    const file = path.join(dataDir, faceFileRelPath(mediaId));

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
        file,
        encodeVectorFile({
            model: "face-rec-arcface-r50",
            stageVersion: 1,
            dims: EMBED_DIMS,
            vectors: people.map((who, i) => ({
                atMs: 0,
                square: 0,
                vector: quantize(faceOf(who, i + mediaId.length)),
            })),
            representatives: [],
        })
    );
    people.forEach((_, vectorIndex) =>
        state.faces.push({ id: `${mediaId}-${vectorIndex}`, mediaId, vectorIndex })
    );
};

const tag = (tagId: string, mediaId: string, count: number): void => {
    for (let vectorIndex = 0; vectorIndex < count; vectorIndex++) {
        state.tagged.push({ tagId, faceId: `${mediaId}-${vectorIndex}`, mediaId, vectorIndex });
    }
};

beforeEach(() => {
    state.confirmed = [];
    state.tagged = [];
    state.faces = [];
    state.written = null;
    state.candidates = [];
    state.counts = { proposed: 0, right: 0, wrong: 0, applied: 0, removed: 0 };
    state.setting = {};
    state.decided = [];
    state.appearances = [];
    state.decisions = [];
    state.batches = [];
});

describe("face references", () => {
    it("finds a performer's face from their tags alone, partners and all", async () => {
        // Jane (1) is in every item; each item has somebody else as well.
        item("a1", [1, 5]);
        item("a2", [1, 6]);
        item("a3", [1, 7]);
        item("stranger", [9]);
        item("lookalike", [1]);
        for (const id of ["a1", "a2", "a3"]) tag("jane", id, 2);

        await runFaceAnchors();

        expect(state.written?.anchors).toEqual([
            { tagId: "jane", items: 3, confirmedItems: 0, sharedItems: 3 },
        ]);
        const matched = new Map(state.written!.matches.map((m) => [m.faceId, m]));

        expect(matched.get("lookalike-0")?.tagId).toBe("jane");
        expect(matched.has("stranger-0")).toBe(false);
        // The partners are not her.
        expect(matched.get("a1-1")?.score ?? 0).toBeLessThan(0.3);

        const file = decodeFaceAnchors(
            new Uint8Array(readFileSync(path.join(dataDir, FACE_ANCHORS_REL_PATH)))
        );

        expect(file.map((a) => a.tagId)).toEqual(["jane"]);
    });

    it("gathers each item's people, and scores each against the references", async () => {
        item("a1", [1, 5]);
        item("a2", [1, 6]);
        item("a3", [1, 7]);
        // Jane twice, a stranger twice, and somebody seen once.
        item("both", [1, 1, 9, 9, 8]);
        for (const id of ["a1", "a2", "a3"]) tag("jane", id, 2);

        await runFaceAnchors();

        const people = state.appearances.filter((person) => person.mediaId === "both");

        expect(people.map((person) => person.faceIds)).toEqual([
            ["both-0", "both-1"],
            ["both-2", "both-3"],
        ]);
        expect(people[0].matchTagId).toBe("jane");
        expect(people[0].score).toBeGreaterThan(0.9);
        expect(people[1].score ?? 0).toBeLessThan(0.3);
    });

    it("keeps out a tags' face that is not the one people confirmed", async () => {
        // Kim is always tagged with her partner (2); people confirmed Kim's own face (3).
        item("k1", [2, 3]);
        item("k2", [2, 3]);
        item("k3", [2]);
        item("k4", [2]);
        for (const id of ["k1", "k2", "k3", "k4"])
            tag("kim", id, id === "k1" || id === "k2" ? 2 : 1);
        state.confirmed = [
            { tagId: "kim", mediaId: "k1", vectorIndex: 1 },
            { tagId: "kim", mediaId: "k2", vectorIndex: 1 },
        ];

        await runFaceAnchors();

        // Two confirmed items are not enough, and the partner's face is not borrowed to make up.
        expect(state.written?.anchors).toEqual([]);
        expect(state.written?.matches).toEqual([]);
    });

    describe("tagging by itself", () => {
        const proposal = (mediaId: string, tagId: string) => ({
            mediaId,
            tagId,
            faceId: `${mediaId}-0`,
            bestScore: 0.7,
            strongFaces: 2,
            named: 0,
            anchorItems: 6,
        });

        beforeEach(() => {
            item("xx", [1]);
            state.candidates = [proposal("x", "jane"), proposal("y", "jane"), proposal("z", "kim")];
        });

        it("only proposes until an administrator lets it tag", async () => {
            await runFaceAnchors();

            expect(state.batches).toEqual([]);
        });

        it("tags one batch per performer, made by faces, in the undo list of whoever allowed it", async () => {
            state.setting = { enabled: true, byUserId: "admin-1" };

            await runFaceAnchors();

            expect(state.batches.map((b) => [b.userId, b.source, b.assignments.length])).toEqual([
                ["admin-1", "ai", 2],
                ["admin-1", "ai", 1],
            ]);
            expect(state.decided.map((d) => d[2])).toEqual(["applied", "applied", "applied"]);
            // Each performer's batch is the app's own decision, undone in History with "Wrong".
            expect(state.decisions).toEqual([
                expect.objectContaining({ actor: "app", verdict: "is", surface: "auto" }),
                expect.objectContaining({ actor: "app", verdict: "is", surface: "auto" }),
            ]);
        });

        it("stops when too much of what it tagged was taken back", async () => {
            state.setting = { enabled: true, byUserId: "admin-1" };
            state.counts = { proposed: 0, right: 0, wrong: 0, applied: 95, removed: 5 };

            await runFaceAnchors();

            expect(state.batches).toEqual([]);
        });
    });
});
