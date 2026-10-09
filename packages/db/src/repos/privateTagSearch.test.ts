import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildTagMatcher, mediaQuerySchema, mentionsIn } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Searching your own private tags, and nobody else's (§6).
 *
 * Private tags are deliberately absent from the FTS document — one shared index cannot hold
 * per-user text without leaking it into other people's results, and `MediaSearchDoc.mediaId`
 * is UNIQUE, so there is exactly one document per item to put it in. They are matched on their
 * names instead, scoped to the viewer.
 *
 * **The leak is the test.** A private tag that cannot be found is an inconvenience its owner
 * will report. A private tag that somebody else finds is a disclosure nobody reports, because
 * the person it belonged to is not in the room when it happens.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaRepo = await import("./mediaRepo.js");
const tagRepo = await import("./tagRepo.js");
const searchRepo = await import("./searchRepo.js");
const mentionRepo = await import("./mentionRepo.js");
const { db: sharedDb } = await import("../db.js");

/** What the worker's `mentionMatch` pass writes: every document matched by the one rule. */
const matchMentions = (): void => {
    const matcher = buildTagMatcher(mentionRepo.vocabulary());

    mentionRepo.writeChanged(
        mentionRepo.documentsAfter(0, 100_000).map((document) => ({
            mediaId: document.mediaId,
            mentions: mentionsIn(document.texts, matcher),
        }))
    );
};

const ADA = "u-ada";
const BEN = "u-ben";
const ROOT = "r1";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "MediaSearchDoc"; DELETE FROM "MediaTag"; DELETE FROM "Tag";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                (?, 'ben@example.test', 'Ben', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA, BEN);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES (?, '/media/v', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run(ROOT);
});

const givenMedia = (id: string, title: string): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "addedAt", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, title);

    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "state", "classification", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 10, CURRENT_TIMESTAMP, ?, 'active', 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, ROOT, `${id}.mp4`, `q-${id}`);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);

    // The shared document, as the index job would write it: library-wide text only.
    searchRepo.upsertDocument({
        mediaId: id,
        filename: id,
        title,
        performers: "",
        tags: "",
        attributes: "",
        notes: "",
        ocr: "",
        variants: "",
    });

    return id;
};

const tagIt = (mediaId: string, name: string, owner: string | null, by: string): void => {
    const tagId = tagRepo.ensureTag("tag", name, owner);

    tagRepo.assign({ mediaId, tagId, userId: owner, createdById: by });
};

const found = (search: string, userId: string, sort: "title" | "relevance" = "title"): string[] =>
    mediaRepo
        .listMedia(mediaQuerySchema.parse({ search, sort }), userId, [ROOT])
        .rows.map((row) => row.id)
        .sort();

describe("finding your own private tags", () => {
    it("finds an item by a private tag only its owner carries", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);

        expect(found("clown", ADA)).toEqual(["m1"]);
    });

    /** The one that matters. Nothing throws if this regresses. */
    it("does not find it for anybody else", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);

        expect(found("clown", BEN)).toEqual([]);
    });

    it("finds it by a prefix, which is what people expect of a tag", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);

        expect(found("clo", ADA)).toEqual(["m1"]);
    });

    /** §5b: the same spellings the shared vocabulary's boxes accept. */
    it("finds it by any word of the tag, and by the tag written glued", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "Aunt Margaret", ADA, ADA);

        expect(found("margaret", ADA)).toEqual(["m1"]);
        expect(found("auntmargaret", ADA)).toEqual(["m1"]);
        expect(found("auntmargaret", BEN)).toEqual([]);
    });

    /** Mirrors the AND semantics of the document side: every word has to land. */
    it("requires every word typed to match one of your tags on that item", () => {
        givenMedia("m1", "Untitled");
        givenMedia("m2", "Untitled");
        tagIt("m1", "clown", ADA, ADA);
        tagIt("m1", "funny", ADA, ADA);
        tagIt("m2", "clown", ADA, ADA);

        expect(found("clown funny", ADA)).toEqual(["m1"]);
    });

    it("still finds items by the shared document", () => {
        givenMedia("m1", "A Clown Show");
        givenMedia("m2", "Something Else");
        tagIt("m2", "unused", ADA, ADA);

        expect(found("clown", ADA)).toEqual(["m1"]);
        expect(found("clown", BEN)).toEqual(["m1"]);
    });

    it("finds an item matched either way, once", () => {
        givenMedia("m1", "A Clown Show");
        tagIt("m1", "clown", ADA, ADA);

        // One row, not two: the match is a filter rather than a join, so however many ways an
        // item qualifies it appears once -- otherwise a page duplicates rows and `hasMore`
        // lies about the end of the library.
        expect(
            mediaRepo.listMedia(mediaQuerySchema.parse({ search: "clown" }), ADA, [ROOT]).rows
        ).toHaveLength(1);
    });

    /** A public tag is in the document, so it is found by everybody without any of this. */
    it("finds a public tag for everybody once it is indexed", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", null, ADA);
        searchRepo.upsertDocument({
            mediaId: "m1",
            filename: "m1",
            title: "Untitled",
            performers: "",
            tags: "clown",
            attributes: "",
            notes: "",
            ocr: "",
        });

        expect(found("clown", ADA)).toEqual(["m1"]);
        expect(found("clown", BEN)).toEqual(["m1"]);
    });
});

/** §5c "One search across what you can see": each word may be found either way. */
describe("mixing the document and your own tags", () => {
    it("finds an item by one word in its document and another you tagged it", () => {
        givenMedia("m1", "beach day");
        givenMedia("m2", "beach walk");
        tagIt("m1", "funny", ADA, ADA);

        expect(found("beach funny", ADA)).toEqual(["m1"]);
        expect(found("funny beach", ADA)).toEqual(["m1"]);
    });

    it("never lets somebody else's private tag supply a word", () => {
        givenMedia("m1", "beach day");
        tagIt("m1", "funny", ADA, ADA);

        expect(found("beach funny", BEN)).toEqual([]);
    });

    it("excludes a word found either way", () => {
        givenMedia("m1", "beach day");
        givenMedia("m2", "beach walk");
        givenMedia("m3", "beach funny hats");
        tagIt("m1", "funny", ADA, ADA);

        // m1 is tagged funny by Ada; m3's document says funny. Neither is a beach without funny.
        expect(found("beach -funny", ADA)).toEqual(["m2"]);
        // Ben has no such tag, so for him only the document's word excludes.
        expect(found("beach -funny", BEN)).toEqual(["m1", "m2"]);
    });
});

describe("finding a private tag by an alias", () => {
    it("finds the item for the tag's owner, by the alias's prefix", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);
        tagRepo.setAliases(tagRepo.resolveName("tag", "clown", ADA)!.tag.id, ["jester"], ADA);

        expect(found("jest", ADA)).toEqual(["m1"]);
    });

    it("does not find it for anybody else", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);
        tagRepo.setAliases(tagRepo.resolveName("tag", "clown", ADA)!.tag.id, ["jester"], ADA);

        expect(found("jester", BEN)).toEqual([]);
    });
});

describe("ordering by relevance", () => {
    /**
     * The bug this file uncovered.
     *
     * `bm25()` is negative and more negative is better, so best-first is ascending -- while
     * `naturalDirection` calls relevance "desc", which is the right word for what a person
     * means. Together they produced `ORDER BY score DESC`: **the worst matches first, on every
     * relevance search ever run.** Nothing failed, the results looked plausible, and no test
     * asserted an order. The column is negated now, so the honest word and the correct order
     * agree.
     */
    it("puts the better text match first", () => {
        givenMedia("m1", "Clown Clown Clown");
        givenMedia("m2", "A show with one clown among a great many other unrelated words here");

        const order = mediaRepo
            .listMedia(mediaQuerySchema.parse({ search: "clown", sort: "relevance" }), ADA, [ROOT])
            .rows.map((row) => row.id);

        expect(order).toEqual(["m1", "m2"]);
    });

    /**
     * A private-tag hit has no bm25 score — it did not come from the index. The join is a LEFT
     * JOIN so it survives at all, and the null coalesces to 0, which is below every negated
     * bm25 score. So text matches come first and private-only hits follow, rather than leading
     * on a score they never earned.
     */
    it("puts document matches ahead of private-tag-only matches", () => {
        givenMedia("m1", "A Clown Show");
        givenMedia("m2", "Untitled");
        tagIt("m2", "clown", ADA, ADA);

        const order = mediaRepo
            .listMedia(mediaQuerySchema.parse({ search: "clown", sort: "relevance" }), ADA, [ROOT])
            .rows.map((row) => row.id);

        expect(order).toEqual(["m1", "m2"]);
    });

    it("still excludes another viewer's private tag when sorted by relevance", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);

        expect(found("clown", BEN, "relevance")).toEqual([]);
    });
});

describe("what a private-tag search must not do", () => {
    /** LIKE's own wildcards are escaped, or a search for "%" would return the library. */
    it("treats a wildcard as a character rather than as a pattern", () => {
        givenMedia("m1", "Untitled");
        givenMedia("m2", "Untitled");
        tagIt("m1", "50 percent", ADA, ADA);

        // "%" survives `normalizeName` as nothing at all, so this is a search with no terms
        // rather than a search for everything.
        expect(found("%", ADA)).toEqual([]);
    });

    it("counts the same set it lists", () => {
        givenMedia("m1", "Untitled");
        tagIt("m1", "clown", ADA, ADA);

        expect(mediaRepo.countMedia(mediaQuerySchema.parse({ search: "clown" }), ADA, [ROOT])).toBe(
            1
        );
        expect(mediaRepo.countMedia(mediaQuerySchema.parse({ search: "clown" }), BEN, [ROOT])).toBe(
            0
        );
    });
});

/**
 * §5d "Find untagged": the files that name a tag -- by its name or an alias, however the name
 * was written -- and do not carry it yet.
 */
describe("finding what names a tag but does not carry it", () => {
    const untagged = (tagId: string, userId: string): string[] => {
        matchMentions();

        return mediaRepo
            .listMedia(mediaQuerySchema.parse({ mentions: tagId, notTags: tagId }), userId, [ROOT])
            .rows.map((row) => row.id)
            .sort();
    };

    it("finds the name in any spelling, and an alias, and leaves out what is already tagged", () => {
        givenMedia("m1", "auntmargaret at the lake");
        givenMedia("m2", "Aunt.Margaret beach");
        givenMedia("m3", "Maggie May birthday");
        givenMedia("m4", "Aunt Margaret already filed");
        givenMedia("m5", "Margaret, an aunt of nobody");
        const tagId = tagRepo.ensureTag("performer", "Aunt Margaret", null);
        tagRepo.setAliases(tagId, ["Maggie May"], ADA);
        tagRepo.assign({ mediaId: "m4", tagId, userId: null, createdById: ADA });

        expect(untagged(tagId, ADA)).toEqual(["m1", "m2", "m3"]);
    });

    it("composes with the search box rather than replacing it", () => {
        givenMedia("m1", "Aunt Margaret beach");
        givenMedia("m2", "Aunt Margaret garden");
        const tagId = tagRepo.ensureTag("performer", "Aunt Margaret", null);

        matchMentions();
        expect(
            mediaRepo
                .listMedia(
                    mediaQuerySchema.parse({ mentions: tagId, notTags: tagId, search: "beach" }),
                    ADA,
                    [ROOT]
                )
                .rows.map((row) => row.id)
        ).toEqual(["m1"]);
    });

    /** An id in a shared address must not search the library for somebody's private name. */
    it("matches nothing for somebody else's private tag", () => {
        givenMedia("m1", "clown party");
        const tagId = tagRepo.ensureTag("tag", "clown", ADA);

        expect(untagged(tagId, ADA)).toEqual(["m1"]);
        expect(untagged(tagId, BEN)).toEqual([]);
    });
});
