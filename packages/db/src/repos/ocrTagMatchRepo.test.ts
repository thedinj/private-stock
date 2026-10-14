import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReconciledText } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Pairs of OCR string and tag (§5d "Tagging performers and sources from what was read").
 *
 * What this file guards is that a decision outlives the matcher: rematching drops a proposal
 * that no longer holds but never a rejection, and the counts the queue is built from leave out
 * exactly the items that are not owed the tag. And that keeping them is cheap: a rematch writes
 * only strings whose pairs change, a recount only counts that moved, and a tag change reaches
 * only the pairs it can have moved (§5d "Counts").
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const repo = await import("./ocrTagMatchRepo.js");
const mediaTextRepo = await import("./mediaTextRepo.js");
const tagRepo = await import("./tagRepo.js");
const tagBatchRepo = await import("./tagBatchRepo.js");
const { db: sharedDb } = await import("../db.js");

const MEDIA = ["m1", "m2", "m3"];
const USER = "u1";
const ROOTS = ["root"];

const addMedia = (id: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt", "listable", "listRootId")
         VALUES (?, 'video', 'Test', CURRENT_TIMESTAMP, 1, 'root')`
    ).run(id);
};

const addTag = (id: string, kind: string, name: string, ownerId: string | null = null): void => {
    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "ownerId", "createdAt", "updatedAt")
         VALUES (?, ?, ?, lower(?), ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, kind, name, name, ownerId);
};

const tagItem = (mediaId: string, tagId: string): void => {
    db.prepare(
        `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES (?, ?, ?, 'user')`
    ).run(`${mediaId}-${tagId}`, mediaId, tagId);
};

const finding = (text: string): ReconciledText => ({
    text,
    textNorm: text.toLowerCase(),
    firstAtMs: 1_000,
    lastAtMs: 9_000,
    confidence: 0.9,
    occurrences: 4,
    stability: 0.5,
    box: { x: 0.7, y: 0.9, w: 0.2, h: 0.05 },
});

const pairs = (): Array<{
    textNorm: string;
    tagId: string;
    state: string | null;
    pendingCount: number;
}> =>
    db
        .prepare(
            `SELECT "textNorm", "tagId", "state", "pendingCount" FROM "OcrTagMatch"
              ORDER BY "textNorm", "tagId"`
        )
        .all() as Array<{
        textNorm: string;
        tagId: string;
        state: string | null;
        pendingCount: number;
    }>;

/** Rows written so far on the connection, for asserting that a step wrote nothing. */
const changes = (): number =>
    (sharedDb.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;

const explain = (sql: string): string =>
    (sharedDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((row) => row.detail)
        .join("\n");

/** The recount's read, as `recountPending` runs it. */
const recountPlan = (): string =>
    explain(
        `SELECT o."id", (SELECT COUNT(DISTINCT t."mediaId")
                           FROM "MediaText" t
                           JOIN "Media" m ON m."id" = t."mediaId"
                          WHERE t."textNorm" = o."textNorm"
                            AND t."reviewState" IS NOT 'dismissed'
                            AND m."listable" = 1
                            AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                             WHERE mt."mediaId" = t."mediaId"
                                               AND mt."tagId" = o."tagId"
                                               AND mt."userId" IS NULL)
                            AND NOT EXISTS (SELECT 1 FROM "OcrTagMatchSkip" s
                                             WHERE s."matchId" = o."id"
                                               AND s."mediaId" = t."mediaId"))
           FROM "OcrTagMatch" o WHERE o."id" IN ('a', 'b')`
    );

beforeEach(() => {
    db = sharedDb as Database.Database;

    db.pragma("foreign_keys = OFF");

    for (const { name } of db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'a@b.c', 'A', 'x', CURRENT_TIMESTAMP)`
    ).run(USER);
    MEDIA.forEach(addMedia);
    addTag("jane", "performer", "Jane Doe");
    addTag("site", "source", "Example Site");
    addTag("word", "tag", "Example");
    addTag("mine", "performer", "Private Person", USER);
});

describe("matching strings", () => {
    it("pairs a string with every performer and source it names", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("JaneDoe examplesite.com")]);
        repo.rematchStrings(["janedoe examplesite.com"]);

        expect(pairs()).toEqual([
            { textNorm: "janedoe examplesite.com", tagId: "jane", state: null, pendingCount: 1 },
            { textNorm: "janedoe examplesite.com", tagId: "site", state: null, pendingCount: 1 },
        ]);
    });

    it("matches neither keywords nor anybody's private tags", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Example Private Person")]);
        repo.rematchStrings(["example private person"]);

        expect(pairs()).toEqual([]);
    });

    it("drops a proposal that no longer holds and keeps a decision", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe at Example Site")]);
        repo.rematchStrings(["jane doe at example site"]);

        const jane = repo
            .candidatesFor(["jane doe at example site"])
            .find((pair) => pair.tagId === "jane")!;

        repo.decide([jane.id], "rejected", USER);
        db.prepare(`DELETE FROM "Tag" WHERE "id" = 'site'`).run();
        db.prepare(
            `UPDATE "Tag" SET "name" = 'Janet', "nameNorm" = 'janet' WHERE "id" = 'jane'`
        ).run();
        repo.rematchStrings(["jane doe at example site"]);

        expect(pairs()).toEqual([
            {
                textNorm: "jane doe at example site",
                tagId: "jane",
                state: "rejected",
                pendingCount: 1,
            },
        ]);
    });

    it("keeps a pair somebody proposed by hand that the matcher does not make", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Some Watermark")]);
        repo.ensureManual("some watermark", "jane", "Some Watermark");
        repo.rematchStrings(["some watermark"]);

        expect(pairs()).toEqual([
            { textNorm: "some watermark", tagId: "jane", state: null, pendingCount: 1 },
        ]);
    });

    it("writes nothing for a string whose pairs would not change", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("JaneDoe examplesite.com")]);
        mediaTextRepo.replaceMachineFindings("m2", [finding("Nobody at all")]);
        repo.rematchStrings(["janedoe examplesite.com", "nobody at all"]);

        const strings = repo.matchableStrings(null, 100);
        const before = changes();

        repo.matchKnownStrings(strings, repo.loadMatcher());
        expect(changes()).toBe(before);

        // One new name: only the string it names is written.
        addTag("nobody", "performer", "Nobody At All");

        const coined = changes();

        repo.matchKnownStrings(strings, repo.loadMatcher());
        expect(changes() - coined).toBe(1);
        expect(pairs().map((pair) => `${pair.textNorm}|${pair.tagId}`)).toEqual([
            "janedoe examplesite.com|jane",
            "janedoe examplesite.com|site",
            "nobody at all|nobody",
        ]);
    });

    it("prunes the pending pairs of a string nobody reads any more", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);
        mediaTextRepo.replaceMachineFindings("m1", []);

        expect(repo.pruneOrphans()).toBe(1);
        expect(pairs()).toEqual([]);
    });

    it("keeps no pending pairs for a string that is gone", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);
        mediaTextRepo.replaceMachineFindings("m1", []);
        repo.rematchStrings(["jane doe"]);

        expect(pairs()).toEqual([]);
    });
});

describe("pending counts", () => {
    beforeEach(() => {
        for (const mediaId of MEDIA) {
            mediaTextRepo.replaceMachineFindings(mediaId, [finding("Jane Doe")]);
        }

        repo.rematchStrings(["jane doe"]);
    });

    it("count every item the string was read on", () => {
        expect(repo.candidatesFor(["jane doe"])[0].untagged).toBe(3);
    });

    it("leave out items already tagged, unlisted, skipped or dismissed", () => {
        const [pair] = repo.candidatesFor(["jane doe"]);

        tagItem("m1", "jane");
        db.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = 'm2'`).run();
        repo.addSkips(pair.id, ["m3"]);

        expect(repo.candidatesFor(["jane doe"])[0].untagged).toBe(0);
        expect(repo.pendingMediaIds(pair.id)).toEqual([]);

        db.prepare(`UPDATE "Media" SET "listable" = 1 WHERE "id" = 'm2'`).run();
        const [row] = mediaTextRepo.listForMedia("m2");

        mediaTextRepo.setReviewState([row.id], "dismissed", USER);
        expect(repo.candidatesFor(["jane doe"])[0].untagged).toBe(0);
    });

    it("are stored when refreshed, and queue the items while above zero", () => {
        expect(pairs()[0].pendingCount).toBe(3);
        expect(repo.countItemQueue(ROOTS)).toEqual({ video: 3, image: 0 });

        for (const mediaId of MEDIA) {
            tagItem(mediaId, "jane");
        }

        expect(repo.recountPending(repo.pairIdsPage(null, 100))).toBe(1);
        expect(pairs()[0].pendingCount).toBe(0);
        expect(repo.countItemQueue(ROOTS)).toEqual({ video: 0, image: 0 });
    });

    /** The queue opens on videos (§5d): photos wait behind its kind control. */
    it("count and list videos and photos apart", () => {
        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" = 'm1'`).run();

        expect(repo.countItemQueue(ROOTS)).toEqual({ video: 2, image: 1 });

        const ids = (media?: "video" | "image") =>
            repo
                .listItemQueue({ rootIds: ROOTS, after: null, limit: 10, media })
                .rows.map((row) => row.mediaId)
                .sort();

        expect(ids("image")).toEqual(["m1"]);
        expect(ids("video")).toEqual(["m2", "m3"]);
        expect(ids()).toEqual(["m1", "m2", "m3"]);
    });

    it("are written only for the pairs whose count moved", () => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe"), finding("Example Site")]);
        repo.rematchStrings(["jane doe", "example site"]);

        const ids = repo.pairIdsPage(null, 100);

        expect(ids).toHaveLength(2);
        expect(repo.recountPending(ids)).toBe(0);

        tagItem("m2", "jane");

        const before = changes();

        expect(repo.recountPending(ids)).toBe(1);
        expect(changes() - before).toBe(1);
        expect(pairs().map((pair) => pair.pendingCount)).toEqual([1, 2]);
    });

    it("are recomputed when written, not copied from the read", () => {
        const [pair] = repo.candidatesFor(["jane doe"]);

        tagItem("m1", "jane");

        // Another change commits between the read and the write; what lands is the truth at
        // the write, not the number the read found.
        const prepare = sharedDb.prepare.bind(sharedDb);
        const spy = vi.spyOn(sharedDb, "prepare").mockImplementation((sql: string) => {
            if (sql.trimStart().startsWith("UPDATE")) {
                tagItem("m2", "jane");
            }

            return prepare(sql);
        });

        try {
            repo.recountPending([pair.id]);
        } finally {
            spy.mockRestore();
        }

        expect(pairs()[0].pendingCount).toBe(1);
    });
});

describe("which pairs a change can move", () => {
    beforeEach(() => {
        addTag("jill", "performer", "Jill Roe");
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe"), finding("Jill Roe")]);
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe at Example Site")]);
        mediaTextRepo.replaceMachineFindings("m3", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe", "jill roe", "jane doe at example site"]);
    });

    const describePairs = (ids: string[]): string[] =>
        repo
            .candidatesFor(["jane doe", "jill roe", "jane doe at example site"])
            .filter((pair) => ids.includes(pair.id))
            .map((pair) => `${pair.textNorm}|${pair.tagId}`)
            .sort();

    it("are the tag's pairs for strings the items show, and nothing else", () => {
        expect(describePairs(repo.pairsTouching(["m1"], ["jane"]))).toEqual(["jane doe|jane"]);
        expect(describePairs(repo.pairsTouching(["m1", "m2"], ["jane"]))).toEqual([
            "jane doe at example site|jane",
            "jane doe|jane",
        ]);
        expect(repo.pairsTouching(["m3"], ["site"])).toEqual([]);
        expect(repo.pairsTouching([], ["jane"])).toEqual([]);
        expect(repo.pairsTouching(["m1"], [])).toEqual([]);
    });

    it("are every pair of the items' strings when the tags are not named", () => {
        expect(describePairs(repo.pairsTouching(["m1"], null))).toEqual([
            "jane doe|jane",
            "jill roe|jill",
        ]);
    });

    it("are found without reading a finding's row", () => {
        const plan = explain(
            `SELECT o."id" FROM "OcrTagMatch" o
              WHERE o."tagId" IN ('jane')
                AND EXISTS (SELECT 1 FROM "MediaText" t
                             WHERE t."textNorm" = o."textNorm" AND t."mediaId" IN ('m1', 'm2'))`
        );

        expect(plan).toContain("idx_OcrTagMatch_tagId");
        expect(plan).toContain("COVERING INDEX idx_MediaText_textNorm");
    });

    it("are recounted from the findings' index, by probes rather than scans", () => {
        const plan = recountPlan();

        expect(plan).toContain("sqlite_autoindex_OcrTagMatch_1");
        expect(plan).toContain("COVERING INDEX idx_MediaText_textNorm");
        // Either MediaTag index answers the (tag, item) probe exactly; which one is the
        // planner's choice. What matters is that it is a probe.
        expect(plan).toMatch(/SEARCH mt USING .*INDEX idx_MediaTag_(unique_library|tagId)/);
        expect(plan).not.toMatch(/SCAN (t|m|mt|s)\b/);
    });
});

describe("decisions", () => {
    beforeEach(() => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);
    });

    it("are reopened when the batch that accepted them is undone", () => {
        const [pair] = repo.candidatesFor(["jane doe"]);

        db.prepare(
            `INSERT INTO "TagBatch" ("id", "userId", "summary", "mediaCount") VALUES ('b1', ?, 's', 1)`
        ).run(USER);
        repo.decide([pair.id], "accepted", USER, "b1");

        expect(repo.reopenForBatch("b1")).toEqual([pair.id]);
        expect(repo.findById(pair.id)?.state).toBeNull();
    });

    it("go with the tag when it is deleted", () => {
        db.prepare(`DELETE FROM "Tag" WHERE "id" = 'jane'`).run();

        expect(pairs()).toEqual([]);
    });
});

/** Back-date an item's findings, to put them before or after a decision. */
const readAt = (mediaId: string, at: string): void => {
    db.prepare(`UPDATE "MediaText" SET "createdAt" = ? WHERE "mediaId" = ?`).run(at, mediaId);
};

const tagsOf = (mediaId: string): Array<{ tagId: string; source: string; createdById: string }> =>
    db
        .prepare(
            `SELECT "tagId", "source", "createdById" FROM "MediaTag"
              WHERE "mediaId" = ? ORDER BY "tagId"`
        )
        .all(mediaId) as Array<{ tagId: string; source: string; createdById: string }>;

describe("the queue", () => {
    beforeEach(() => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe"), finding("Example Site")]);
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        mediaTextRepo.replaceMachineFindings("m3", [finding("Nobody")]);
        repo.rematchStrings(["jane doe", "example site", "nobody"]);
        readAt("m1", "2026-01-01 00:00:00");
        readAt("m2", "2026-02-01 00:00:00");
        db.prepare(`UPDATE "OcrTagMatch" SET "createdAt" = '2025-01-01 00:00:00'`).run();
        db.prepare(`UPDATE "Tag" SET "createdAt" = '2024-01-01 00:00:00'`).run();
    });

    const ids = (page: { rows: Array<{ mediaId: string }> }): string[] =>
        page.rows.map((row) => row.mediaId);

    it("lists the items with something to decide, most recently read first, a page at a time", () => {
        const first = repo.listItemQueue({ rootIds: ROOTS, after: null, limit: 1 });

        expect(ids(first)).toEqual(["m2"]);

        const second = repo.listItemQueue({ rootIds: ROOTS, after: first.next, limit: 1 });

        expect(ids(second)).toEqual(["m1"]);
        expect(second.next).toBeNull();
        expect(repo.countItemQueue(ROOTS)).toEqual({ video: 2, image: 0 });
        expect(repo.listItemQueue({ rootIds: ["another"], after: null, limit: 10 }).rows).toEqual(
            []
        );
    });

    it("brings an old item to the top when the pair that names it is new", () => {
        db.prepare(
            `UPDATE "OcrTagMatch" SET "createdAt" = '2026-03-01 00:00:00'
              WHERE "textNorm" = 'example site'`
        ).run();

        expect(ids(repo.listItemQueue({ rootIds: ROOTS, after: null, limit: 10 }))).toEqual([
            "m1",
            "m2",
        ]);
    });

    it("drops an item once it is tagged, skipped or the pair is decided", () => {
        const [jane] = repo.candidatesFor(["jane doe"]);
        const [site] = repo.candidatesFor(["example site"]);

        repo.addSkips(jane.id, ["m2"]);
        repo.recountPending([jane.id]);
        expect(ids(repo.listItemQueue({ rootIds: ROOTS, after: null, limit: 10 }))).toEqual(["m1"]);

        tagItem("m1", "jane");
        repo.decide([site.id], "rejected", USER);
        repo.recountPending([jane.id, site.id]);
        expect(repo.countItemQueue(ROOTS)).toEqual({ video: 0, image: 0 });
    });

    it("gives each item its open pairs, with the finding and the live count", () => {
        const candidates = repo.itemCandidates(["m1", "m2"]);

        expect(
            candidates.map((row) => `${row.mediaId}|${row.textNorm}|${row.tagId}|${row.untagged}`)
        ).toEqual(["m1|example site|site|1", "m1|jane doe|jane|2", "m2|jane doe|jane|2"]);
        expect(candidates.every((row) => row.newName === 0)).toBe(true);
    });

    it("says when the name was added after the item was read", () => {
        db.prepare(
            `UPDATE "Tag" SET "createdAt" = '2026-01-15 00:00:00' WHERE "id" = 'jane'`
        ).run();

        const byItem = repo
            .itemCandidates(["m1", "m2"])
            .filter((row) => row.tagId === "jane")
            .map((row) => [row.mediaId, row.newName]);

        expect(byItem).toEqual([
            ["m1", 1],
            ["m2", 0],
        ]);
    });
});

describe("the Rules list", () => {
    beforeEach(() => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe"), finding("Example Site")]);
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe", "example site"]);
    });

    it("lists decided strings by state, most-read first", () => {
        const [jane] = repo.candidatesFor(["jane doe"]);
        const [site] = repo.candidatesFor(["example site"]);

        repo.decide([jane.id], "accepted", USER);
        repo.decide([site.id], "rejected", USER);

        const list = (status: "accepted" | "rejected"): string[] =>
            repo.listQueue({ status, after: null, limit: 10 }).rows.map((row) => row.textNorm);

        expect(list("accepted")).toEqual(["jane doe"]);
        expect(list("rejected")).toEqual(["example site"]);
    });

    it("walks the strings in the order of their count index", () => {
        const plan = explain(
            `SELECT s."textNorm" FROM "MediaTextString" s INDEXED BY "idx_MediaTextString_count"
              WHERE EXISTS (SELECT 1 FROM "OcrTagMatch" o
                             WHERE o."textNorm" = s."textNorm" AND o."state" = 'accepted')
                AND (-s."rowCount", s."textNorm") > (-3, 'x')
              ORDER BY -s."rowCount", s."textNorm" LIMIT 50`
        );

        expect(plan).toContain("idx_MediaTextString_count");
        expect(plan).not.toContain("TEMP B-TREE");
    });
});

describe("rules", () => {
    let jane: string;

    /** Accept Jane Doe for "Jane Doe" the way the queue does: tag what is shown, then decide. */
    beforeEach(() => {
        mediaTextRepo.replaceMachineFindings("m1", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);
        readAt("m1", "2026-01-01 00:00:00");
        jane = repo.candidatesFor(["jane doe"])[0].id;
        tagItem("m1", "jane");
        repo.decide([jane], "accepted", USER);
    });

    it("tag an item that reads the string after the decision, as the rule's", () => {
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);

        expect(tagsOf("m2")).toEqual([{ tagId: "jane", source: "ocr", createdById: USER }]);
        expect(pairs()[0].pendingCount).toBe(0);
        expect(repo.countItemQueue(ROOTS)).toEqual({ video: 0, image: 0 });
    });

    it("leave alone an item that read the string before the decision", () => {
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        readAt("m2", "2025-06-01 00:00:00");
        repo.rematchStrings(["jane doe"]);

        expect(tagsOf("m2")).toEqual([]);
    });

    it("apply nothing for a pair nobody accepted", () => {
        repo.decide([jane], "rejected", USER);
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);

        expect(tagsOf("m2")).toEqual([]);
    });

    it("never put back a tag somebody took off, even when the item is read again", () => {
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);
        db.prepare(`DELETE FROM "MediaTag" WHERE "mediaId" = 'm2'`).run();
        repo.declineRules(["m2"], null, "performer");

        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);

        expect(tagsOf("m2")).toEqual([]);
    });

    it("are not declined by adding tags, or by an edit to another facet", () => {
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        readAt("m2", "2025-06-01 00:00:00");
        repo.declineRules(["m2"], null, "source");
        repo.declineRules(["m1"], ["jane"], "performer");

        expect(db.prepare(`SELECT COUNT(*) FROM "OcrTagMatchSkip"`).pluck().get()).toBe(0);
    });

    it("are withdrawn with their own tags only", () => {
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);

        expect(repo.withdrawRuleTags(jane)).toEqual(["m2"]);
        expect(tagsOf("m1")).toEqual([{ tagId: "jane", source: "user", createdById: null }]);
        expect(tagsOf("m2")).toEqual([]);
    });

    /**
     * A duplicate trashed after a rule tagged it hands its tags to the copy kept, batch and all
     * (§10c). That copy may not show the string, so only the batch can find its tag again.
     */
    it("are linked to the accept's batch, so withdrawing reaches a copy a duplicate handed on", () => {
        db.prepare(
            `INSERT INTO "TagBatch" ("id", "userId", "summary", "mediaCount") VALUES ('b1', ?, 'Jane', 1)`
        ).run(USER);
        repo.decide([jane], "accepted", USER, "b1");
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);
        tagRepo.copyAssignments("m2", "m3");

        expect(tagsOf("m3")).toEqual([{ tagId: "jane", source: "ocr", createdById: USER }]);

        tagBatchRepo.undo("b1");

        expect(tagsOf("m2")).toEqual([]);
        expect(tagsOf("m3")).toEqual([]);
    });

    it("do not attach to a batch that has been withdrawn", () => {
        db.prepare(
            `INSERT INTO "TagBatch" ("id", "userId", "summary", "mediaCount", "undoneAt")
             VALUES ('b2', ?, 'Jane', 1, CURRENT_TIMESTAMP)`
        ).run(USER);
        repo.decide([jane], "accepted", USER, "b2");
        mediaTextRepo.replaceMachineFindings("m2", [finding("Jane Doe")]);
        repo.rematchStrings(["jane doe"]);

        expect(
            db.prepare(`SELECT "batchId" FROM "MediaTag" WHERE "mediaId" = 'm2'`).pluck().get()
        ).toBeNull();
    });

    it("are logged newest first, a page at a time", () => {
        for (const mediaId of ["m2", "m3"]) {
            mediaTextRepo.replaceMachineFindings(mediaId, [finding("Jane Doe")]);
        }

        repo.rematchStrings(["jane doe"]);
        db.prepare(
            `UPDATE "MediaTag" SET "createdAt" = '2099-01-01 00:00:00' WHERE "mediaId" = 'm3'`
        ).run();

        const first = repo.listRuleTags({ rootIds: ROOTS, after: null, limit: 1 });
        const second = repo.listRuleTags({ rootIds: ROOTS, after: first.next, limit: 1 });

        expect(first.rows.map((row) => row.mediaId)).toEqual(["m3"]);
        expect(second.rows.map((row) => row.mediaId)).toEqual(["m2"]);
        expect(second.next).toBeNull();
        expect(repo.ruleFinding("m2", "jane")?.text).toBe("Jane Doe");
    });

    it("read the log from its own index", () => {
        const plan = explain(
            `SELECT mt."id" FROM "MediaTag" mt INDEXED BY "idx_MediaTag_ocr"
              WHERE mt."source" = 'ocr' AND mt."userId" IS NULL
              ORDER BY mt."createdAt" DESC, mt."id" DESC LIMIT 30`
        );

        expect(plan).toContain("idx_MediaTag_ocr");
        expect(plan).not.toContain("TEMP B-TREE");
    });
});
