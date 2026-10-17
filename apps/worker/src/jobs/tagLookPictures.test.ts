import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    EMBED_DIMS,
    REPRESENTATIVES_LOG_REL_PATH,
    encodeRepresentatives,
    normaliseVector,
    quantize,
} from "@private-stock/core";

/**
 * A source's or a keyword's picture from how its items look (§6 "A tag's picture"): drawn from the
 * most typical frame of a tag whose items look alike, left alone while it is still close to the
 * best, and a stand-in for one with no typical frame. A real representatives log in a temporary
 * data directory; the rows and ffmpeg are stood in for.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "ps-looks-"));

interface Row {
    tagId: string;
    source: "auto";
    relPath: string;
    smallRelPath: string;
    mediaId: string | null;
    atMs: number | null;
}

const state = vi.hoisted(() => ({
    members: [] as { tagId: string; mediaId: string }[],
    listable: [] as string[],
    rows: [] as Row[],
    drawn: [] as { tagId: string; mediaId: string; atMs: number | null }[],
    withdrawn: [] as string[],
    /** What `standInFor` offers each tag. */
    standIns: new Map<string, { mediaId: string; atMs: number | null }>(),
}));

vi.mock("@private-stock/db", () => ({
    tagPictureRepo: {
        listableMediaIds: () => state.listable,
        lookPictureMembers: () => state.members,
        listAuto: () => state.rows,
        originalOf: () => ({ kind: "video", fileId: "file" }),
        standInFor: (tagId: string) => {
            const standIn = state.standIns.get(tagId);

            return standIn && { ...standIn, kind: "video", fileId: "file" };
        },
    },
}));

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
}));

/**
 * Which frame a tile really shows is `tagPicture.ts`'s, and asserted in `tagPictures.test.ts`;
 * here the frame is the tile's own moment, so what is asserted is which tile was chosen.
 */
vi.mock("../media/tagPicture.js", () => {
    const draw = async (source: { tagId: string; mediaId: string; atMs: number | null }) => {
        state.drawn.push({ tagId: source.tagId, mediaId: source.mediaId, atMs: source.atMs });

        return true;
    };
    const shows = (row: Row, moment: { mediaId: string; atMs: number | null }) =>
        row.mediaId === moment.mediaId && row.atMs === moment.atMs;

    return {
        drawAutoPicture: draw,
        drawFromTile: draw,
        withdrawAutoPicture: async (row: Row) => {
            state.withdrawn.push(row.tagId);
        },
        showsTile: shows,
    };
});

vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { runTagLookPictures } = await import("./tagLookPictures.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** A repeatable pseudo-random unit vector, its values spread evenly about zero. */
const randomVector = (seed: number): Float32Array => {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    return normaliseVector(Float32Array.from({ length: EMBED_DIMS }, () => next() - 0.5));
};

/** Near `centre`, by `spread`. */
const near = (centre: Float32Array, seed: number, spread: number): Float32Array => {
    const noise = randomVector(seed);

    return normaliseVector(centre.map((value, i) => value + spread * noise[i]));
};

/** The log, one record per item, two moments each. */
const writeLog = (items: Map<string, Float32Array[]>): void => {
    const file = path.join(dataDir, REPRESENTATIVES_LOG_REL_PATH);
    const records = [...items].map(([mediaId, vectors]) =>
        encodeRepresentatives(mediaId, {
            model: "test",
            stageVersion: 1,
            dims: EMBED_DIMS,
            vectors: vectors.map((vector, index) => ({
                atMs: (index + 1) * 1000,
                square: 0,
                vector: quantize(vector),
            })),
            representatives: vectors.map((_, index) => index),
        })
    );

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.concat(records.map((bytes) => Buffer.from(bytes))));
};

const BEACH = "beach-tag";
const MIXED = "mixed-tag";
const centre = randomVector(1);

beforeEach(() => {
    const items = new Map<string, Float32Array[]>();

    // A library of unrelated items, and eight that look alike: the beach.
    for (let i = 0; i < 200; i += 1) items.set(`lib-${i}`, [randomVector(100 + i)]);
    for (let i = 0; i < 8; i += 1) {
        items.set(`beach-${i}`, [near(centre, 500 + i, 0.6), near(centre, 600 + i, 1.2)]);
    }

    // The most typical frame: closest of all to the beach's look.
    items.set("beach-best", [near(centre, 700, 0.05), near(centre, 701, 1.5)]);

    writeLog(items);
    state.listable = [...items.keys()];
    state.members = [
        ...[...Array(8).keys()].map((i) => ({ tagId: BEACH, mediaId: `beach-${i}` })),
        { tagId: BEACH, mediaId: "beach-best" },
        ...[...Array(8).keys()].map((i) => ({ tagId: MIXED, mediaId: `lib-${i * 7}` })),
    ];
    state.rows = [];
    state.drawn = [];
    state.withdrawn = [];
    state.standIns = new Map([[MIXED, { mediaId: "lib-7", atMs: 4000 }]]);
});

const mixedPicture = (mediaId: string): Row => ({
    tagId: MIXED,
    source: "auto",
    relPath: "tags/mi/mixed-tag-auto-large.webp",
    smallRelPath: "tags/mi/mixed-tag-auto-small.webp",
    mediaId,
    atMs: 1000,
});

const drawnFor = (tagId: string) => state.drawn.filter((draw) => draw.tagId === tagId);

describe("runTagLookPictures", () => {
    it("draws a tag whose items look alike from its most typical frame", async () => {
        await runTagLookPictures();

        expect(drawnFor(BEACH)).toEqual([{ tagId: BEACH, mediaId: "beach-best", atMs: 1000 }]);
    });

    it("gives a tag whose items are no more alike than any a stand-in", async () => {
        await runTagLookPictures();

        expect(drawnFor(MIXED)).toEqual([{ tagId: MIXED, mediaId: "lib-7", atMs: 4000 }]);
    });

    it("keeps a stand-in while its item still carries the tag", async () => {
        state.rows = [mixedPicture("lib-0")];

        await runTagLookPictures();

        expect(drawnFor(MIXED)).toEqual([]);
        expect(state.withdrawn).toEqual([]);
    });

    it("draws another once its item no longer carries the tag", async () => {
        state.rows = [mixedPicture("gone")];

        await runTagLookPictures();

        expect(drawnFor(MIXED)).toEqual([{ tagId: MIXED, mediaId: "lib-7", atMs: 4000 }]);
    });

    it("withdraws a picture when there is no stand-in to replace it", async () => {
        state.rows = [mixedPicture("gone")];
        state.standIns.clear();

        await runTagLookPictures();

        expect(state.withdrawn).toEqual([MIXED]);
    });

    it("pictures tags by a stand-in before anything has been embedded", async () => {
        rmSync(path.join(dataDir, REPRESENTATIVES_LOG_REL_PATH), { force: true });
        state.standIns.set(BEACH, { mediaId: "beach-3", atMs: 2000 });

        await runTagLookPictures();

        expect(state.drawn.map((draw) => draw.mediaId).sort()).toEqual(["beach-3", "lib-7"]);
    });

    it("leaves a picture that is still as typical as any", async () => {
        state.rows = [
            {
                tagId: BEACH,
                source: "auto",
                relPath: "tags/be/beach-tag-auto-large.webp",
                smallRelPath: "tags/be/beach-tag-auto-small.webp",
                mediaId: "beach-best",
                atMs: 1000,
            },
        ];

        await runTagLookPictures();

        expect(drawnFor(BEACH)).toEqual([]);
        expect(state.withdrawn).toEqual([]);
    });

    it("needs a few items before anything is typical", async () => {
        state.members = state.members.filter(
            (member) => member.tagId !== BEACH || member.mediaId < "beach-4"
        );

        await runTagLookPictures();

        // No typical frame, and no stand-in offered for it here.
        expect(drawnFor(BEACH)).toEqual([]);
    });
});
