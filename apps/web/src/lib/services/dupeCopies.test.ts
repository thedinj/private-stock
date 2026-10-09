import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, ConflictError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Trashing an item with its copies, from its delete confirmation (§10d).
 *
 * What this adds to a single deletion, and each is a way to lose the wrong thing or the wrong
 * record: listing copies in roots the viewer cannot see, trashing a copy that was not on
 * screen, stopping at the first refusal, and trashing in an order that scatters everybody's
 * ratings across the bin instead of gathering them on the copy worth restoring.
 */

interface Row {
    id: string;
    kind: "video" | "image";
    title: string | null;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    codec: string | null;
    addedAt: string;
    capturedAt: string | null;
    sizeBytes: number | null;
    relPath: string;
    contentHash: string | null;
    rootId: string;
    rootLabel: string;
    writable: number | null;
    coverPath: string | null;
    coverGeneratedAt: string | null;
    clipCount: number;
}

let rows: Row[] = [];
let trashed: string[] = [];
let refuse: Record<string, Error> = {};

const active = () => rows.filter((row) => !trashed.includes(row.id));

vi.mock("@private-stock/db", () => ({
    db: { prepare: () => ({ all: () => active() }) },
    mediaRepo: {
        findDetail: (mediaId: string) => (rows.some((row) => row.id === mediaId) ? {} : undefined),
    },
    dupeRepo: {
        activeCopies: () =>
            active().map((row) => ({
                mediaId: row.id,
                width: row.width,
                height: row.height,
                bitrate: row.bitrate,
                sizeBytes: row.sizeBytes,
                durationMs: row.durationMs,
                addedAt: row.addedAt,
            })),
    },
}));

vi.mock("./artService", () => ({ coverUrl: (id: string) => `/art/${id}` }));
vi.mock("./keepAdvice", () => ({ costOfKeeping: () => null, keepReason: () => null }));

vi.mock("./trashService", () => ({
    trashMedia: async (mediaId: string) => {
        const error = refuse[mediaId];

        if (error) throw error;
        if (trashed.includes(mediaId)) throw new ConflictError("This item is already in the trash");

        trashed.push(mediaId);

        return { entryId: `t-${mediaId}`, queued: true, merged: null };
    },
}));

const { listCopies, trashWithCopies } = await import("./dupeService");

const viewer: AuthContext = {
    userId: "u1",
    email: "a@b.c",
    displayName: "Viewer",
    scopes: ["delete"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 1,
};

/** A copy; `height` decides the ranking, so 1080 beats 720 beats 480. */
const copy = (id: string, height: number, fields: Partial<Row> = {}): Row => ({
    id,
    kind: "video",
    title: id,
    durationMs: 600_000,
    width: Math.round((height * 16) / 9),
    height,
    bitrate: 1_000,
    codec: "h264",
    addedAt: "2026-01-01T00:00:00Z",
    capturedAt: null,
    sizeBytes: 1_000,
    relPath: `${id}.mp4`,
    contentHash: `hash-${id}`,
    rootId: "r1",
    rootLabel: "Films",
    writable: 1,
    coverPath: `${id}.jpg`,
    coverGeneratedAt: null,
    clipCount: 0,
    ...fields,
});

beforeEach(() => {
    rows = [copy("item", 720), copy("best", 1080), copy("worst", 480)];
    trashed = [];
    refuse = {};
});

describe("listing an item's copies", () => {
    it("lists the others best first, marking the best", () => {
        const { copies } = listCopies("item", viewer);

        expect(copies.map((each) => each.id)).toEqual(["best", "worst"]);
        expect(copies.map((each) => each.best)).toEqual([true, false]);
    });

    it("calls a copy identical only when its bytes match the item's", () => {
        rows = [
            copy("item", 720, { contentHash: "same" }),
            copy("twin", 720, { contentHash: "same" }),
            copy("unhashed", 720, { contentHash: null }),
        ];

        const byId = Object.fromEntries(
            listCopies("item", viewer).copies.map((each) => [each.id, each.identical])
        );

        expect(byId).toEqual({ twin: true, unhashed: false });
    });

    it("leaves out copies in libraries the viewer cannot see", () => {
        rows.push(copy("elsewhere", 2160, { rootId: "r2" }));

        const { copies } = listCopies("item", viewer);

        expect(copies.map((each) => each.id)).toEqual(["best", "worst"]);
        // The ranking still reads it: "Best copy" means what it means on the item's detail.
        expect(copies.some((each) => each.best)).toBe(false);
    });

    it("flags a copy that runs much longer as one that may hold more than the item", () => {
        rows.push(copy("film", 720, { durationMs: 7_200_000 }));

        const film = listCopies("item", viewer).copies.find((each) => each.id === "film");

        expect(film?.caution).toMatch(/may hold more than this/);
    });

    it("asks nothing about an identical copy", () => {
        rows = [
            copy("item", 720, { contentHash: "same" }),
            copy("twin", 720, { contentHash: "same", coverPath: null }),
        ];

        expect(listCopies("item", viewer).copies[0]?.caution).toBeNull();
    });
});

describe("trashing an item with its copies", () => {
    it("is the plain single deletion when no copy is named", async () => {
        const result = await trashWithCopies("item", [], viewer);

        expect(trashed).toEqual(["item"]);
        expect(result).toEqual({ trashed: ["item"], failed: [] });
    });

    it("trashes worst first and the best last, so the records gather on the best", async () => {
        await trashWithCopies("item", ["best", "worst"], viewer);

        expect(trashed).toEqual(["worst", "item", "best"]);
    });

    it("never touches a copy that was not on screen", async () => {
        // A clustering pass added "newcomer"; the dialog never showed it.
        rows.push(copy("newcomer", 480));

        await trashWithCopies("item", ["worst"], viewer);

        expect(trashed).toEqual(["worst", "item"]);
    });

    it("refuses a named copy in a library the viewer cannot see", async () => {
        rows.push(copy("elsewhere", 480, { rootId: "r2" }));

        const result = await trashWithCopies("item", ["elsewhere"], viewer);

        expect(trashed).toEqual(["item"]);
        expect(result.failed).toEqual([
            { mediaId: "elsewhere", reason: "No longer one of this item's copies" },
        ]);
    });

    it("trashes what it can when one copy refuses, and names the one that did not", async () => {
        refuse.worst = new ConflictError("Not enough free space");

        const result = await trashWithCopies("item", ["best", "worst"], viewer);

        expect(trashed).toEqual(["item", "best"]);
        expect(result.failed).toEqual([{ mediaId: "worst", reason: "Not enough free space" }]);
    });

    it("reports the item itself when it is already in the bin", async () => {
        trashed = ["item"];

        const result = await trashWithCopies("item", ["worst"], viewer);

        expect(result.failed.map((failure) => failure.mediaId)).toContain("item");
    });

    it("needs the delete scope, and says so before touching anything", async () => {
        await expect(
            trashWithCopies("item", ["worst"], { ...viewer, scopes: [] })
        ).rejects.toBeInstanceOf(AuthorizationError);
        expect(trashed).toEqual([]);
    });
});
