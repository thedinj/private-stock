import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * Unreadable files (§10g): what the page is shown, and what purging a selection does.
 *
 * The repo's query is tested against a real database in `stageRepo.test.ts`; this is the part
 * with judgement in it -- who may look, which reason is shown, and which entries a purge may
 * touch.
 */

interface Row {
    mediaId: string;
    fileId: string;
    entryId: string | null;
    title: string;
    rootLabel: string;
    relPath: string;
    bytes: number;
    detail: string | null;
    at: string;
    writable: 1 | null;
    moving: 0 | 1;
}

let rows: Row[] = [];
let purged: string[] = [];
let lastFilter: { place: string; rootIds: string[]; mediaIds?: string[] } | null = null;

vi.mock("@private-stock/db", () => ({
    stageRepo: {
        listSettledFailures: (
            _stage: unknown,
            filter: { place: string; rootIds: string[]; mediaIds?: string[] }
        ) => {
            lastFilter = filter;

            return {
                rows: filter.mediaIds
                    ? rows.filter((row) => filter.mediaIds?.includes(row.mediaId))
                    : rows,
                next: null,
            };
        },
        summarizeSettledFailures: () => ({ count: rows.length, bytes: 0 }),
    },
    trashRepo: {
        enqueueMove: (_kind: string, entryId: string) => purged.push(entryId),
    },
}));

const { listUnreadable, purgeUnreadable } = await import("./unreadableService");

const admin: AuthContext = {
    userId: "u1",
    email: "a@example.com",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
} as AuthContext;

const viewer: AuthContext = { ...admin, scopes: [] } as AuthContext;

const row = (overrides: Partial<Row> = {}): Row => ({
    mediaId: "m1",
    fileId: "f1",
    entryId: "t1",
    title: "Clip",
    rootLabel: "Videos",
    relPath: "dl/clip.mp4",
    bytes: 1000,
    detail: null,
    at: "2026-10-01 00:00:00",
    writable: 1,
    moving: 0,
    ...overrides,
});

beforeEach(() => {
    rows = [];
    purged = [];
    lastFilter = null;
});

describe("listUnreadable", () => {
    it("is refused to anyone who is not an administrator", () => {
        expect(() => listUnreadable({ tab: "library", limit: 50 }, viewer)).toThrow(
            /administrator/
        );
    });

    it("lists only the libraries the caller can reach", () => {
        listUnreadable({ tab: "library", limit: 50 }, admin);

        expect(lastFilter).toMatchObject({ place: "library", rootIds: ["r1"] });
    });

    /** The line that names the damage, not ffprobe's command line or its closing summary. */
    it("shows the marker line as the reason, and calls the file corrupt", () => {
        rows = [
            row({
                detail:
                    "Command failed: ffprobe -v error /media/dl/clip.mp4\n" +
                    "[mov,mp4 @ 0x1] moov atom not found\n" +
                    "/media/dl/clip.mp4: Invalid data found when processing input",
            }),
        ];

        const [item] = listUnreadable({ tab: "library", limit: 50 }, admin).items;

        expect(item).toMatchObject({
            reason: "[mov,mp4 @ 0x1] moov atom not found",
            corrupt: true,
        });
    });

    it("does not call a timed-out probe corrupt", () => {
        rows = [row({ detail: "ffprobe was stopped at its time limit" })];

        expect(listUnreadable({ tab: "library", limit: 50 }, admin).items[0]).toMatchObject({
            reason: "ffprobe was stopped at its time limit",
            corrupt: false,
        });
    });

    it("refuses a cursor it did not issue rather than starting again", () => {
        expect(() =>
            listUnreadable({ tab: "library", limit: 50, after: "nonsense" }, admin)
        ).toThrow(/no longer valid/);
    });
});

describe("purgeUnreadable", () => {
    it("is refused to anyone who is not an administrator", () => {
        expect(() => purgeUnreadable({ mediaIds: ["m1"] }, viewer)).toThrow(/administrator/);
    });

    it("purges what is in the trash and reports the space", () => {
        rows = [row(), row({ mediaId: "m2", entryId: "t2", bytes: 500 })];

        expect(purgeUnreadable({ mediaIds: ["m1", "m2"] }, admin)).toEqual({
            queued: 2,
            waiting: 0,
            freedBytes: 1500,
        });
        expect(purged).toEqual(["t1", "t2"]);
        expect(lastFilter).toMatchObject({ place: "trash", mediaIds: ["m1", "m2"] });
    });

    /**
     * Its original is still in the media root. Purging it would delete the catalogue row and
     * leave the file for the next scan to adopt as something new.
     */
    it("leaves an entry whose move has not finished", () => {
        rows = [row({ moving: 1 })];

        expect(purgeUnreadable({ mediaIds: ["m1"] }, admin)).toEqual({
            queued: 0,
            waiting: 1,
            freedBytes: 0,
        });
        expect(purged).toEqual([]);
    });

    it("passes over an id the list would not show", () => {
        rows = [row()];

        expect(purgeUnreadable({ mediaIds: ["somebody-else"] }, admin).queued).toBe(0);
        expect(purged).toEqual([]);
    });
});
