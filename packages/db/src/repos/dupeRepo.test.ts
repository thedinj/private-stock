import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The bookkeeping an incremental clustering pass rests on (§10b).
 *
 * The pass stopped comparing the whole library against itself and now only seeds with items
 * that have never been compared. That is only correct because comparison is symmetric and
 * because anything a new item touches is pulled back in and re-clustered — so what these
 * tests cover is the selection of seeds, and the lookup that finds the groups a merge has to
 * absorb. Get either wrong and the review queue shows the same files in two groups, which is
 * not an error anything would report.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const dupeRepo = await import("./dupeRepo.js");
const { db: sharedDb } = await import("../db.js");

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "DupeMember"; DELETE FROM "DupeGroup"; DELETE FROM "DupeClustered";
        DELETE FROM "PhashImage"; DELETE FROM "PhashVideo";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot";
    `);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES ('r1', '/media/v', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run();
});

/** An item with an original file, optionally carrying a content hash or a perceptual one. */
const givenMedia = (
    id: string,
    options: { contentHash?: string; imageHash?: boolean; addedMinutesAgo?: number } = {}
): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "addedAt", "updatedAt")
         VALUES (?, 'image', datetime('now', ?), CURRENT_TIMESTAMP)`
    ).run(id, `-${options.addedMinutesAgo ?? 0} minutes`);

    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "contentHash", "state", "classification", "lastSeenAt",
                                  "updatedAt")
         VALUES (?, 'r1', ?, 10, CURRENT_TIMESTAMP, ?, ?, 'active', 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, `${id}.jpg`, `q-${id}`, options.contentHash ?? null);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);

    if (options.imageHash) {
        db.prepare(
            `INSERT INTO "PhashImage" ("mediaId", "hash", "band0", "band1", "band2", "band3",
                                       "band4", "band5", "band6", "band7")
             VALUES (?, X'0011223344556677', 0, 0, 0, 0, 0, 0, 0, 0)`
        ).run(id);
    }

    return id;
};

describe("seedsNeedingClustering", () => {
    it("offers an item that has a hash and has never been compared", () => {
        givenMedia("m1", { imageHash: true });

        expect(dupeRepo.seedsNeedingClustering()).toEqual(["m1"]);
    });

    it("ignores an item with nothing to compare", () => {
        givenMedia("m1");

        expect(dupeRepo.seedsNeedingClustering()).toEqual([]);
    });

    /**
     * The whole basis of the incremental pass. Comparison is symmetric, so an item already
     * compared against the library would only rediscover the pairs it found the first time.
     */
    it("stops offering an item once it has been compared", () => {
        givenMedia("m1", { imageHash: true });
        dupeRepo.markClustered(["m1"]);

        expect(dupeRepo.seedsNeedingClustering()).toEqual([]);
    });

    it("counts a content hash alone, since exact duplicates need no perceptual hash", () => {
        givenMedia("m1", { contentHash: "abc" });

        expect(dupeRepo.seedsNeedingClustering()).toEqual(["m1"]);
    });

    it("offers the newest first, like everything else the queue does", () => {
        givenMedia("old", { imageHash: true, addedMinutesAgo: 60 });
        givenMedia("new", { imageHash: true, addedMinutesAgo: 1 });

        expect(dupeRepo.seedsNeedingClustering()).toEqual(["new", "old"]);
    });

    it("respects its limit, so one pass stays bounded however large the library is", () => {
        for (let i = 0; i < 5; i += 1) {
            givenMedia(`m${i}`, { imageHash: true });
        }

        expect(dupeRepo.seedsNeedingClustering(2)).toHaveLength(2);
    });

    /**
     * Marking is idempotent because a pass can be reclaimed and run twice — the heartbeat
     * window is sixty seconds and a pass is not guaranteed to be shorter.
     */
    it("can be marked twice without complaint", () => {
        givenMedia("m1", { imageHash: true });
        dupeRepo.markClustered(["m1"]);

        expect(() => dupeRepo.markClustered(["m1"])).not.toThrow();
    });

    it("forgets every mark when the thresholds change", () => {
        givenMedia("m1", { imageHash: true });
        dupeRepo.markClustered(["m1"]);

        expect(dupeRepo.clearClustered()).toBe(1);
        expect(dupeRepo.seedsNeedingClustering()).toEqual(["m1"]);
    });
});

describe("groupsContaining", () => {
    /**
     * The lookup that keeps clustering transitive across passes. A new item linking two
     * items that were in separate groups has to merge those groups; without this the pass
     * writes a third group overlapping both and the same files appear twice in review.
     */
    it("finds every group any of the named items belongs to", () => {
        givenMedia("a");
        givenMedia("b");
        givenMedia("c");
        givenMedia("d");

        const left = dupeRepo.upsertGroup({
            kind: "near",
            members: [
                { mediaId: "a", distance: 1 },
                { mediaId: "b", distance: 1 },
            ],
        });
        const right = dupeRepo.upsertGroup({
            kind: "near",
            members: [
                { mediaId: "c", distance: 1 },
                { mediaId: "d", distance: 1 },
            ],
        });

        // A new item linking b and c must pull both groups in.
        const found = dupeRepo.groupsContaining(["b", "c"]).map((group) => group.id);

        expect(new Set(found)).toEqual(new Set([left, right]));
    });

    it("finds nothing for items in no group", () => {
        givenMedia("a");

        expect(dupeRepo.groupsContaining(["a"])).toEqual([]);
    });

    it("is empty rather than a syntax error for an empty list", () => {
        // An IN () with no placeholders is not valid SQL; the guard is load-bearing.
        expect(dupeRepo.groupsContaining([])).toEqual([]);
        expect(dupeRepo.membersOf([])).toEqual([]);
        expect(dupeRepo.deleteGroups([])).toBe(0);
        expect(dupeRepo.exactDuplicateSetsFor([])).toEqual([]);
    });
});

describe("exactDuplicateSetsFor", () => {
    it("finds the whole set a seed belongs to, not just the seed", () => {
        givenMedia("a", { contentHash: "same" });
        givenMedia("b", { contentHash: "same" });
        givenMedia("c", { contentHash: "same" });

        const sets = dupeRepo.exactDuplicateSetsFor(["a"]);

        expect(sets).toHaveLength(1);
        expect(new Set(sets[0])).toEqual(new Set(["a", "b", "c"]));
    });

    it("says nothing about a file whose hash is unique", () => {
        givenMedia("a", { contentHash: "one" });
        givenMedia("b", { contentHash: "two" });

        expect(dupeRepo.exactDuplicateSetsFor(["a"])).toEqual([]);
    });

    it("ignores a file that is no longer active", () => {
        givenMedia("a", { contentHash: "same" });
        givenMedia("b", { contentHash: "same" });
        db.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-b'`).run();

        expect(dupeRepo.exactDuplicateSetsFor(["a"])).toEqual([]);
    });
});

describe("deleteGroups", () => {
    it("removes the group and its members", () => {
        givenMedia("a");
        givenMedia("b");

        const id = dupeRepo.upsertGroup({
            kind: "near",
            members: [
                { mediaId: "a", distance: 1 },
                { mediaId: "b", distance: 1 },
            ],
        });

        expect(dupeRepo.deleteGroups([id])).toBe(1);
        expect(dupeRepo.findGroup(id)).toBeUndefined();
        expect(dupeRepo.listMembers(id)).toEqual([]);
    });
});

describe("upsertGroup guards", () => {
    /**
     * `UNIQUE (groupId, mediaId)` would turn this into a thrown constraint that fails the
     * whole clustering job. A group listing the same file twice is what the review screen
     * must never show, so it is made impossible to express rather than merely unlikely.
     */
    it("never writes the same item into a group twice", () => {
        givenMedia("a");
        givenMedia("b");

        const id = dupeRepo.upsertGroup({
            kind: "near",
            members: [
                { mediaId: "a", distance: 1 },
                { mediaId: "a", distance: 2 },
                { mediaId: "b", distance: 1 },
            ],
        });

        expect(
            dupeRepo
                .listMembers(id)
                .map((m) => m.mediaId)
                .sort()
        ).toEqual(["a", "b"]);
    });

    it("refuses a group that is not two distinct items", () => {
        givenMedia("a");

        expect(
            dupeRepo.upsertGroup({
                kind: "near",
                members: [
                    { mediaId: "a", distance: 0 },
                    { mediaId: "a", distance: 0 },
                ],
            })
        ).toBe("");

        expect((db.prepare(`SELECT count(*) AS n FROM "DupeGroup"`).get() as { n: number }).n).toBe(
            0
        );
    });
});

describe("pruneSubsumed", () => {
    const groupOf = (kind: "near" | "exact", ids: string[]): string =>
        dupeRepo.upsertGroup({
            kind,
            members: ids.map((mediaId) => ({ mediaId, distance: 1 })),
        });

    beforeEach(() => {
        for (const id of ["a", "b", "c", "d"]) {
            givenMedia(id);
        }
    });

    /**
     * The regression, and it was not hypothetical: one item was left in ten overlapping near
     * groups of two, three, four, five, six, seven, eight and nine members, each written as
     * the previous one grew and none of them removed.
     */
    it("removes a group whose members are all in a larger one", () => {
        const small = groupOf("near", ["a", "b"]);
        const large = groupOf("near", ["a", "b", "c"]);

        expect(dupeRepo.pruneSubsumed()).toBe(1);
        expect(dupeRepo.findGroup(small)).toBeUndefined();
        expect(dupeRepo.findGroup(large)).toBeDefined();
    });

    it("collapses a chain of grown groups down to the largest", () => {
        groupOf("near", ["a", "b"]);
        groupOf("near", ["a", "b", "c"]);
        const largest = groupOf("near", ["a", "b", "c", "d"]);

        expect(dupeRepo.pruneSubsumed()).toBe(2);
        expect(dupeRepo.findGroup(largest)).toBeDefined();
    });

    it("leaves groups that merely overlap alone", () => {
        // Neither contains the other, so both are real and the reviewer needs to see both.
        const left = groupOf("near", ["a", "b"]);
        const right = groupOf("near", ["b", "c"]);

        expect(dupeRepo.pruneSubsumed()).toBe(0);
        expect(dupeRepo.findGroup(left)).toBeDefined();
        expect(dupeRepo.findGroup(right)).toBeDefined();
    });

    /**
     * An exact group and a near group over the same files answer different questions (§10),
     * so one must never swallow the other.
     */
    it("never lets one kind subsume the other", () => {
        const near = groupOf("near", ["a", "b"]);
        const exact = groupOf("exact", ["a", "b", "c"]);

        expect(dupeRepo.pruneSubsumed()).toBe(0);
        expect(dupeRepo.findGroup(near)).toBeDefined();
        expect(dupeRepo.findGroup(exact)).toBeDefined();
    });

    it("keeps exactly one of two identical groups, deterministically", () => {
        const first = groupOf("near", ["a", "b"]);
        // upsertGroup returns the existing id for an identical set, so force a second row.
        db.prepare(
            `INSERT INTO "DupeGroup" ("id", "kind", "updatedAt")
             VALUES ('zzz', 'near', CURRENT_TIMESTAMP)`
        ).run();
        db.prepare(
            `INSERT INTO "DupeMember" ("id", "groupId", "mediaId") VALUES
                 ('x1', 'zzz', 'a'), ('x2', 'zzz', 'b')`
        ).run();

        expect(dupeRepo.pruneSubsumed()).toBe(1);
        // The lower id survives, whichever way the planner walked the tables.
        expect(dupeRepo.findGroup(first < "zzz" ? first : "zzz")).toBeDefined();
    });

    it("finds nothing to do in a healthy library", () => {
        groupOf("near", ["a", "b"]);
        groupOf("near", ["c", "d"]);

        expect(dupeRepo.pruneSubsumed()).toBe(0);
    });
});

describe("mergeOverlapping", () => {
    const groupOf = (kind: "near" | "exact", ids: string[]): string =>
        dupeRepo.upsertGroup({
            kind,
            members: ids.map((mediaId) => ({ mediaId, distance: 1 })),
        });

    beforeEach(() => {
        for (const id of ["a", "b", "c", "d", "e"]) {
            givenMedia(id);
        }
    });

    /**
     * The case `pruneSubsumed` cannot touch, and should not: neither group contains the
     * other. The live library held two nine-member groups sharing eight members and differing
     * by one -- one group of ten, written twice as it grew.
     */
    it("folds two groups that share a member into one", () => {
        groupOf("near", ["a", "b", "c"]);
        groupOf("near", ["c", "d", "e"]);

        expect(dupeRepo.mergeOverlapping()).toBe(1);

        const groups = db.prepare(`SELECT "id" FROM "DupeGroup"`).all() as { id: string }[];
        expect(groups).toHaveLength(1);
        expect(
            dupeRepo
                .listMembers(groups[0].id)
                .map((m) => m.mediaId)
                .sort()
        ).toEqual(["a", "b", "c", "d", "e"]);
    });

    /** Each merge can create another overlap, so one pass has to reach a fixed point. */
    it("keeps going until the groups are disjoint", () => {
        groupOf("near", ["a", "b"]);
        groupOf("near", ["b", "c"]);
        groupOf("near", ["c", "d"]);

        dupeRepo.mergeOverlapping();

        const groups = db.prepare(`SELECT "id" FROM "DupeGroup"`).all() as { id: string }[];
        expect(groups).toHaveLength(1);
        expect(dupeRepo.listMembers(groups[0].id)).toHaveLength(4);
    });

    /**
     * An exact group and a near group over the same files answer different questions (§10),
     * so sharing a member between them is expected rather than a fault.
     */
    it("never merges across kinds", () => {
        groupOf("near", ["a", "b"]);
        groupOf("exact", ["b", "c"]);

        expect(dupeRepo.mergeOverlapping()).toBe(0);
        expect(db.prepare(`SELECT count(*) AS n FROM "DupeGroup"`).get()).toEqual({ n: 2 });
    });

    it("leaves disjoint groups alone", () => {
        groupOf("near", ["a", "b"]);
        groupOf("near", ["c", "d"]);

        expect(dupeRepo.mergeOverlapping()).toBe(0);
    });

    /**
     * A group somebody approved is not the group they looked at once it has grown, so the
     * survivor goes back into the queue rather than quietly carrying an approval of a
     * smaller set.
     */
    it("un-reviews a group that actually gained members", () => {
        const left = groupOf("near", ["a", "b"]);
        groupOf("near", ["b", "c"]);
        dupeRepo.markReviewed(left, true);

        dupeRepo.mergeOverlapping();

        const survivor = (db.prepare(`SELECT "id" FROM "DupeGroup"`).get() as { id: string }).id;
        expect(dupeRepo.findGroup(survivor)?.reviewed).toBeNull();
    });

    it("stops at its bound rather than looping for ever", () => {
        groupOf("near", ["a", "b"]);
        groupOf("near", ["b", "c"]);
        groupOf("near", ["c", "d"]);

        expect(dupeRepo.mergeOverlapping(1)).toBe(1);
    });
});

describe("counting the queue", () => {
    /**
     * A group whose other copies have gone is not a duplicate any more, and is never shown. It
     * used to be counted anyway: "Reviewed · 1" over a tab with nothing on it.
     */
    it("leaves out a group with fewer than two copies still in the library", () => {
        for (const id of ["a", "b", "c", "d"]) givenMedia(id);

        const live = dupeRepo.upsertGroup({
            kind: "exact",
            members: [
                { mediaId: "a", distance: 0 },
                { mediaId: "b", distance: 0 },
            ],
        });
        const emptied = dupeRepo.upsertGroup({
            kind: "exact",
            members: [
                { mediaId: "c", distance: 0 },
                { mediaId: "d", distance: 0 },
            ],
        });

        db.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-d'`).run();
        dupeRepo.markReviewedMany([live, emptied], true);

        expect(dupeRepo.countGroups({ reviewed: true })).toBe(1);
        expect(dupeRepo.listGroups({ reviewed: true }).map((group) => group.id)).toEqual([live]);

        dupeRepo.markReviewedMany([live, emptied], false);

        expect(dupeRepo.countPending()).toEqual({
            exact: { video: 0, image: 1 },
            near: { video: 0, image: 0 },
        });
    });

    /** The review queues open on videos (§10c): a group is filtered whole, by its members' kind. */
    it("filters and counts groups by what they are groups of", () => {
        for (const id of ["a", "b", "c", "d"]) givenMedia(id);
        db.prepare(`UPDATE "Media" SET "kind" = 'video' WHERE "id" IN ('c', 'd')`).run();

        const photos = dupeRepo.upsertGroup({
            kind: "exact",
            members: [
                { mediaId: "a", distance: 0 },
                { mediaId: "b", distance: 0 },
            ],
        });
        const videos = dupeRepo.upsertGroup({
            kind: "near",
            members: [
                { mediaId: "c", distance: 3 },
                { mediaId: "d", distance: 3 },
            ],
        });

        expect(dupeRepo.listGroups({ media: "video" }).map((group) => group.id)).toEqual([videos]);
        expect(dupeRepo.listGroups({ media: "image" }).map((group) => group.id)).toEqual([photos]);
        expect(dupeRepo.countGroups({ media: "video" })).toBe(1);
        expect(dupeRepo.countGroups({})).toBe(2);
        expect(dupeRepo.countPending()).toEqual({
            exact: { video: 0, image: 1 },
            near: { video: 1, image: 0 },
        });
        expect(dupeRepo.pendingIdenticalCopies("video")).toEqual([]);
        expect(dupeRepo.pendingIdenticalCopies("image")).toHaveLength(2);
    });
});

describe("tilePrintedVideos", () => {
    const givenVideo = (
        id: string,
        options: { durationMs: number; printed?: boolean; fileState?: string }
    ): void => {
        givenMedia(id);
        db.prepare(`UPDATE "Media" SET "kind" = 'video', "durationMs" = ? WHERE "id" = ?`).run(
            options.durationMs,
            id
        );
        db.prepare(`UPDATE "MediaFile" SET "state" = ? WHERE "id" = ?`).run(
            options.fileState ?? "active",
            `f-${id}`
        );

        if (options.printed ?? true) {
            db.prepare(
                `INSERT INTO "MediaStage" ("mediaId", "stage", "state") VALUES (?, 'tileprint', 'done')`
            ).run(id);
        }
    };

    beforeEach(() => {
        db.exec(`DELETE FROM "MediaStage"`);
    });

    it("lists printed videos with an active original, shortest first", () => {
        givenVideo("long", { durationMs: 90_000 });
        givenVideo("short", { durationMs: 30_000 });
        givenVideo("unprinted", { durationMs: 40_000, printed: false });
        givenVideo("gone", { durationMs: 50_000, fileState: "missing" });

        expect(dupeRepo.tilePrintedVideos()).toEqual([
            { mediaId: "short", durationMs: 30_000 },
            { mediaId: "long", durationMs: 90_000 },
        ]);
    });
});

describe("forgetClustered", () => {
    it("offers the item as a seed again, and leaves the others marked", () => {
        givenMedia("m1", { imageHash: true });
        givenMedia("m2", { imageHash: true });
        dupeRepo.markClustered(["m1", "m2"]);

        dupeRepo.forgetClustered("m1");

        expect(dupeRepo.seedsNeedingClustering()).toEqual(["m1"]);
    });
});
