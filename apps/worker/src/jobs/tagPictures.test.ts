import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A performer's picture from their faces (§6 "A tag's picture"): drawn from the best face that
 * makes one, a tier at a time, left alone while that face is still the best, and withdrawn when
 * none does. ffmpeg and the rows are stood in for; what is asserted is which face was used and when.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "ps-tagpictures-"));

interface Candidate {
    tagId: string;
    mediaId: string;
    kind: "video" | "image";
    atMs: number | null;
    x: number;
    y: number;
    w: number;
    h: number;
    score: number;
    fileId: string;
    tier: 1 | 2 | 3;
}

interface Row {
    tagId: string;
    source: "auto" | "user";
    relPath: string;
    smallRelPath: string;
    mediaId: string | null;
    atMs: number | null;
}

const state = vi.hoisted(() => ({
    candidates: [] as Candidate[],
    rows: new Map<string, Row>(),
    /** The frame each item's original decodes to. */
    frames: new Map<string, { width: number; height: number }>(),
    reads: [] as string[],
}));

vi.mock("@private-stock/db", () => ({
    db: {},
    faceRepo: { pictureCandidates: () => state.candidates },
    tagPictureRepo: {
        listAuto: () => [...state.rows.values()],
        upsert: (input: Row & { crop: unknown }) => {
            state.rows.set(input.tagId, { ...input, source: "auto" });
        },
        remove: (tagId: string) => {
            const row = state.rows.get(tagId);

            state.rows.delete(tagId);

            return row;
        },
    },
}));

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
}));

vi.mock("../media/sourcePath.js", () => ({
    resolveSource: (fileId: string) => ({
        absolutePath: `/media/${fileId}`,
        rootId: "r",
        relPath: fileId,
    }),
}));

/** The scratch frame is named for the tag; its size is the item's frame, by the input's name. */
const lastInput = new Map<string, string>();

vi.mock("../media/frames.js", () => ({
    extractFrame: async (input: string, output: string) => {
        if (input.startsWith("/media/")) {
            state.reads.push(input.slice("/media/".length));
            lastInput.set(output, input.slice("/media/file-".length));
        }
    },
    imageDimensions: async (file: string) =>
        state.frames.get(lastInput.get(file) ?? "") ?? { width: null, height: null },
}));

vi.mock("../queue.js", () => ({ enqueue: vi.fn() }));
vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { runTagPictures } = await import("./tagPictures.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** A tag id: the paths are built from it, and refuse anything that is not one. */
const JANE = "jane-tag";

const face = (tagId: string, mediaId: string, h: number, tier: 1 | 2 | 3 = 1): Candidate => ({
    tagId,
    mediaId,
    kind: "video",
    atMs: 5000,
    x: 0.4,
    y: 0.2,
    w: h * 0.45,
    h,
    score: 0.9,
    fileId: `file-${mediaId}`,
    tier,
});

beforeEach(() => {
    state.candidates = [];
    state.rows.clear();
    state.frames.clear();
    state.reads = [];
    lastInput.clear();
});

describe("runTagPictures", () => {
    it("draws a performer's picture from their best face", async () => {
        state.candidates = [face(JANE, "a", 0.3)];
        state.frames.set("a", { width: 1920, height: 1080 });

        await runTagPictures();

        expect(state.rows.get(JANE)).toMatchObject({ mediaId: "a", atMs: 5000 });
        expect(state.reads).toEqual(["file-a"]);
    });

    it("passes over a face too small in its original for the next", async () => {
        state.candidates = [face(JANE, "small", 0.3), face(JANE, "large", 0.25)];
        state.frames.set("small", { width: 320, height: 240 });
        state.frames.set("large", { width: 1920, height: 1080 });

        await runTagPictures();

        expect(state.rows.get(JANE)?.mediaId).toBe("large");
    });

    it("falls back to a face their automatic tag rests on", async () => {
        state.candidates = [face(JANE, "small", 0.3), face(JANE, "auto", 0.3, 2)];
        state.frames.set("small", { width: 320, height: 240 });
        state.frames.set("auto", { width: 1920, height: 1080 });

        await runTagPictures();

        expect(state.rows.get(JANE)?.mediaId).toBe("auto");
    });

    it("takes a confirmed face below the bars as a last resort, at a smaller size", async () => {
        // 72 pixels tall: too small for a picture from the first tiers, enough for the last.
        state.candidates = [face(JANE, "soft", 0.1, 3)];
        state.frames.set("soft", { width: 1280, height: 720 });

        await runTagPictures();

        expect(state.rows.get(JANE)?.mediaId).toBe("soft");
    });

    it("leaves a performer with only a tiny face without a picture", async () => {
        state.candidates = [face(JANE, "tiny", 0.05, 3)];
        state.frames.set("tiny", { width: 640, height: 360 });

        await runTagPictures();

        expect(state.rows.has(JANE)).toBe(false);
    });

    it("reads nothing when the picture already shows their best face", async () => {
        state.candidates = [face(JANE, "a", 0.3)];
        state.rows.set(JANE, {
            tagId: JANE,
            source: "auto",
            relPath: "tags/ja/jane-tag-auto-large.webp",
            smallRelPath: "tags/ja/jane-tag-auto-small.webp",
            mediaId: "a",
            atMs: 5000,
        });

        await runTagPictures();

        expect(state.reads).toEqual([]);
        expect(state.rows.get(JANE)?.mediaId).toBe("a");
    });

    it("withdraws a picture whose face is no longer theirs", async () => {
        state.rows.set(JANE, {
            tagId: JANE,
            source: "auto",
            relPath: "tags/ja/jane-tag-auto-large.webp",
            smallRelPath: "tags/ja/jane-tag-auto-small.webp",
            mediaId: "a",
            atMs: 5000,
        });

        await runTagPictures();

        expect(state.rows.has(JANE)).toBe(false);
    });
});
