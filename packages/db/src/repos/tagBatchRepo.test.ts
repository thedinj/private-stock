import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Bulk tagging and its undo (§5d).
 *
 * One claim carries the whole feature: **withdrawing a batch must not take away anything a
 * person typed.** Without it, bulk tagging is a one-way door and nobody should use it on a
 * library they care about. The mechanism is that an item already carrying the tag is skipped
 * by the unique index, so its row never joins the batch and the undo cannot reach it — which
 * is exactly the kind of guarantee that holds by accident until someone changes the INSERT.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagBatchRepo = await import("./tagBatchRepo.js");
const tagRepo = await import("./tagRepo.js");
const { db: sharedDb } = await import("../db.js");

const USER = "bbbbbbbb-0000-4000-8000-000000000000";

const addMedia = (id: string): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
    ).run(id, id);

    return id;
};

const tagsOn = (mediaId: string): { tagId: string; batchId: string | null }[] =>
    db.prepare(`SELECT "tagId", "batchId" FROM "MediaTag" WHERE "mediaId" = ?`).all(mediaId) as {
        tagId: string;
        batchId: string | null;
    }[];

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    const virtualPrefixes = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "sql" LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

    for (const table of (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)))) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
         VALUES (?, 'a@b.c', 'Curator', 'x', '', CURRENT_TIMESTAMP)`
    ).run(USER);
});

describe("applying a batch", () => {
    it("tags every item and reports how many rows it wrote", () => {
        const ids = ["a", "b", "c"].map(addMedia);
        const tagId = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        const result = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 3 items",
            mediaIds: ids,
            tagIds: [tagId],
        });

        expect(result.assigned).toBe(3);
        expect(tagsOn("a")).toEqual([{ tagId, batchId: result.batchId }]);
    });

    it("writes one row per item per tag", () => {
        const ids = ["a", "b"].map(addMedia);
        const tagIds = ["Jane Doe", "John Roe"].map((name) =>
            tagRepo.ensureTag("performer", name, null, USER)
        );

        expect(
            tagBatchRepo.apply({
                userId: USER,
                summary: "Tagged 2 items",
                mediaIds: ids,
                tagIds,
            }).assigned
        ).toBe(4);
    });
});

describe("undo", () => {
    /**
     * The claim the feature rests on.
     *
     * A person tags one item by hand; a careless bulk apply later covers the same item; the
     * bulk apply is withdrawn. The hand-applied tag must still be there — it was never part
     * of the batch, because the unique index refused the duplicate.
     */
    it("leaves a hand-applied tag alone when the same tag was later applied in bulk", () => {
        addMedia("a");
        const tagId = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        tagRepo.assign({ mediaId: "a", tagId, source: "user" });

        const { batchId, assigned } = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 1 item",
            mediaIds: ["a"],
            tagIds: [tagId],
        });

        // The duplicate was ignored, so nothing joined the batch.
        expect(assigned).toBe(0);

        tagBatchRepo.undo(batchId);

        expect(tagsOn("a")).toEqual([{ tagId, batchId: null }]);
    });

    it("removes exactly the rows the batch wrote, and nothing from another batch", () => {
        ["a", "b"].forEach(addMedia);
        const first = tagRepo.ensureTag("performer", "Jane Doe", null, USER);
        const second = tagRepo.ensureTag("studio", "Acme", null, USER);

        const one = tagBatchRepo.apply({
            userId: USER,
            summary: "One",
            mediaIds: ["a", "b"],
            tagIds: [first],
        });
        tagBatchRepo.apply({
            userId: USER,
            summary: "Two",
            mediaIds: ["a", "b"],
            tagIds: [second],
        });

        expect(tagBatchRepo.undo(one.batchId)).toBe(2);
        expect(tagsOn("a").map((row) => row.tagId)).toEqual([second]);
    });

    it("takes back a tag it was the only use of, and keeps one still used elsewhere", () => {
        ["a", "b"].forEach(addMedia);
        const typo = tagRepo.ensureTag("performer", "Jnae Doe", null, USER);
        const used = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        tagRepo.assign({ mediaId: "b", tagId: used, source: "user" });

        const { batchId } = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 1 item",
            mediaIds: ["a"],
            tagIds: [typo, used],
        });

        tagBatchRepo.undo(batchId);

        expect(tagRepo.findById(typo)).toBeUndefined();
        expect(tagRepo.findById(used)).toBeDefined();
    });

    /**
     * The record outlives the rows.
     *
     * After an undo there is nothing left to describe what happened, and "you tagged four
     * thousand items and then changed your mind" is what somebody needs to see before
     * trusting the feature a second time.
     */
    it("keeps the batch record and marks when it was withdrawn", () => {
        addMedia("a");
        const tagId = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        const { batchId } = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 1 item performer: Jane Doe",
            mediaIds: ["a"],
            tagIds: [tagId],
        });

        tagBatchRepo.undo(batchId);

        const batch = tagBatchRepo.findById(batchId, USER);

        expect(batch?.summary).toBe("Tagged 1 item performer: Jane Doe");
        expect(batch?.mediaCount).toBe(1);
        expect(batch?.undoneAt).not.toBeNull();
    });

    it("collects the affected items before they are deleted", () => {
        ["a", "b"].forEach(addMedia);
        const tagId = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        const { batchId } = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 2 items",
            mediaIds: ["a", "b"],
            tagIds: [tagId],
        });

        expect(tagBatchRepo.affectedMediaIds(batchId).sort()).toEqual(["a", "b"]);

        tagBatchRepo.undo(batchId);

        // Which is why the service reads them first — afterwards there is nothing to reindex.
        expect(tagBatchRepo.affectedMediaIds(batchId)).toEqual([]);
    });

    /**
     * A tag deleted afterwards takes its assignments with it, by cascade.
     *
     * The batch is then a record of something that can no longer be undone, which is honest:
     * the rows are already gone, and the summary still says what was done.
     */
    it("survives the tag itself being deleted", () => {
        addMedia("a");
        const tagId = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        const { batchId } = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 1 item",
            mediaIds: ["a"],
            tagIds: [tagId],
        });

        tagRepo.removeTag(tagId);

        expect(tagBatchRepo.findById(batchId, USER)).toBeDefined();
        expect(tagBatchRepo.undo(batchId)).toBe(0);
    });
});

describe("ownership", () => {
    it("does not return another account's batch", () => {
        addMedia("a");
        const tagId = tagRepo.ensureTag("performer", "Jane Doe", null, USER);

        const { batchId } = tagBatchRepo.apply({
            userId: USER,
            summary: "Tagged 1 item",
            mediaIds: ["a"],
            tagIds: [tagId],
        });

        expect(tagBatchRepo.findById(batchId, "someone-else")).toBeUndefined();
        expect(tagBatchRepo.listForUser("someone-else", 10)).toEqual([]);
    });
});
