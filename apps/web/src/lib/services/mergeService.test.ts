import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KeepCandidate, UserOverlay } from "@private-stock/core";

/**
 * Who inherits, and what it costs when nobody recorded anything (§10c).
 *
 * The conflict rules are pure and tested in `@private-stock/core`; the SQL is tested against
 * a real database in `packages/db`. What is left here is the orchestration, and it has two
 * ways to be wrong that nothing else would catch: bequeathing to the wrong copy, and firing
 * notifications or a re-index for a merge that moved nothing.
 */

interface OverlayRow extends UserOverlay {
    userId: string;
}

let siblings: KeepCandidate[] = [];
let overlays: Record<string, OverlayRow[]> = {};
let written: { userId: string; mediaId: string; overlay: UserOverlay }[] = [];
let copiedTags = 0;
let repointed = 0;
let changes: { entityId: string; detail?: string }[] = [];
let reindexed: string[] = [];

const candidate = (mediaId: string, pixels: number): KeepCandidate => ({
    mediaId,
    width: pixels,
    height: pixels,
    bitrate: null,
    sizeBytes: null,
    durationMs: null,
    addedAt: "2026-01-01 00:00:00",
});

const overlay = (userId: string, fields: Partial<UserOverlay>): OverlayRow => ({
    userId,
    rating: null,
    favorite: false,
    hidden: false,
    viewCount: 0,
    lastViewedAt: null,
    watchedAt: null,
    note: null,
    ...fields,
});

vi.mock("@private-stock/db", () => ({
    // Callable, with `.immediate` beside it, as better-sqlite3 returns a transaction.
    db: { transaction: (fn: () => unknown) => Object.assign(() => fn(), { immediate: fn }) },
    dupeRepo: { activeSiblings: () => siblings },
    userMediaRepo: {
        listOverlays: (mediaId: string) => overlays[mediaId] ?? [],
        writeOverlay: (userId: string, mediaId: string, value: UserOverlay) => {
            written.push({ userId, mediaId, overlay: value });
        },
    },
    tagRepo: { copyAssignments: () => copiedTags },
    playlistRepo: { repointItems: () => repointed },
    changeLogRepo: {
        record: (change: { entityId: string; detail?: string }) => changes.push(change),
    },
    searchRepo: { requestReindex: (ids: string[]) => reindexed.push(...ids) },
}));

const { mergeIntoSurvivingCopy } = await import("./mergeService");

beforeEach(() => {
    siblings = [];
    overlays = {};
    written = [];
    copiedTags = 0;
    repointed = 0;
    changes = [];
    reindexed = [];
});

describe("merging a departing copy into the one that survives", () => {
    it("does nothing for an item that is not a duplicate of anything", () => {
        expect(mergeIntoSurvivingCopy("a")).toBeNull();
        expect(written).toEqual([]);
        expect(changes).toEqual([]);
    });

    /**
     * The same function that marks "Best copy" on the review screen. An heir chosen by a
     * second, unseen rule would put the ratings on a copy the reviewer was told to delete.
     */
    it("bequeaths to the copy the review screen already recommends", () => {
        siblings = [candidate("b", 720), candidate("c", 1080)];
        overlays.a = [overlay("u1", { rating: 5 })];

        expect(mergeIntoSurvivingCopy("a")?.heirId).toBe("c");
        expect(written).toEqual([
            { userId: "u1", mediaId: "c", overlay: expect.objectContaining({ rating: 5 }) },
        ]);
    });

    it("carries every viewer's record, not just the one doing the deleting", () => {
        siblings = [candidate("b", 720)];
        overlays.a = [overlay("u1", { rating: 4 }), overlay("u2", { favorite: true })];

        expect(mergeIntoSurvivingCopy("a")?.overlays).toBe(2);
        expect(written.map((row) => row.userId)).toEqual(["u1", "u2"]);
    });

    it("leaves a viewer alone when the survivor already says everything the copy did", () => {
        siblings = [candidate("b", 720)];
        overlays.a = [overlay("u1", { rating: 4 })];
        overlays.b = [overlay("u1", { rating: 4 })];

        expect(mergeIntoSurvivingCopy("a")?.overlays).toBe(0);
        expect(written).toEqual([]);
    });

    /**
     * A duplicate nobody ever rated, tagged or listed is the common case, and it must not
     * wake an open grid or queue a search document rebuild for a document that has not
     * changed.
     */
    it("announces nothing when there was nothing to move", () => {
        siblings = [candidate("b", 720)];

        expect(mergeIntoSurvivingCopy("a")).toEqual({
            heirId: "b",
            overlays: 0,
            tags: 0,
            playlists: 0,
        });
        expect(changes).toEqual([]);
        expect(reindexed).toEqual([]);
    });

    it("tells the open grids when the survivor gained something", () => {
        siblings = [candidate("b", 720)];
        overlays.a = [overlay("u1", { rating: 5 })];

        mergeIntoSurvivingCopy("a");

        expect(changes).toEqual([
            expect.objectContaining({ entityId: "b", detail: "merge:duplicate" }),
        ]);
    });

    /** Only tags reach the shared search document (§5c) — a rating changes nothing in it. */
    it("rebuilds the search document only when tags moved", () => {
        siblings = [candidate("b", 720)];
        overlays.a = [overlay("u1", { rating: 5 })];

        mergeIntoSurvivingCopy("a");
        expect(reindexed).toEqual([]);

        copiedTags = 2;
        mergeIntoSurvivingCopy("a");
        expect(reindexed).toEqual(["b"]);
    });
});
