import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Reading and moving the vocabulary (§6).
 *
 * Two accounts, because the interesting half of every rule here is what the *other* person
 * sees, and no other test file can check it: there is no way to create a second account
 * through the app, which is exactly why the guarantees need a home that does not need one.
 *
 * The scope change is the part worth the most care. `Tag.ownerId` and `MediaTag.userId`
 * agreeing is the model's definition of privacy, so a move that updated one and not the other
 * would leave a private tag on a public assignment — visible to everybody, and reported as
 * private by every read that asks.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagRepo = await import("./tagRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADA = "u-ada";
const BEN = "u-ben";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "MediaTag"; DELETE FROM "Tag"; DELETE FROM "Media"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                (?, 'ben@example.test', 'Ben', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA, BEN);
});

/** `listable` set explicitly: the counts join it, so an invisible item must not count. */
const givenMedia = (id: string, listable = true): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "updatedAt")
         VALUES (?, 'video', ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, id, listable ? 1 : null);

    return id;
};

const tagIt = (mediaId: string, tagId: string, owner: string | null, by: string): void => {
    tagRepo.assign({ mediaId, tagId, userId: owner, createdById: by });
};

const names = (result: { rows: { name: string }[] }): string[] => result.rows.map((r) => r.name);

const page = (owner: string | null, options = {}) =>
    tagRepo.listVocabulary(owner, { limit: 50, offset: 0, ...options });

describe("listing a vocabulary", () => {
    it("returns one system's tags and never the other's", () => {
        tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.ensureTag("tag", "therapy", ADA, ADA);
        tagRepo.ensureTag("tag", "todo", BEN, BEN);

        expect(names(page(null))).toEqual(["beach"]);
        expect(names(page(ADA))).toEqual(["therapy"]);
        expect(names(page(BEN))).toEqual(["todo"]);
    });

    /**
     * Ordered by facet then name, not by count. This is a list to *find* a tag in, and a
     * count-ordered one puts the unused tags last — which is where a page limit cuts them off,
     * and they are exactly what somebody tidying up came for.
     */
    it("orders by facet then name", () => {
        tagRepo.ensureTag("tag", "zebra", null, ADA);
        tagRepo.ensureTag("performer", "alice", null, ADA);
        tagRepo.ensureTag("tag", "apple", null, ADA);

        expect(names(page(null))).toEqual(["alice", "apple", "zebra"]);
    });

    it("keeps a tag nothing carries", () => {
        tagRepo.ensureTag("tag", "unused", null, ADA);

        expect(names(page(null))).toEqual(["unused"]);
    });

    it("finds by prefix, case and spacing folded", () => {
        tagRepo.ensureTag("tag", "Jane Doe", null, ADA);
        tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(names(page(null, { search: "jane" }))).toEqual(["Jane Doe"]);
        expect(names(page(null, { search: "JANE  doe" }))).toEqual(["Jane Doe"]);
        expect(names(page(null, { search: "nothing" }))).toEqual([]);
    });

    /**
     * §5b: a messy vocabulary writes one name many ways, and every box that finds a tag by
     * typing has to meet it whichever way it was written.
     */
    it("finds by any word of the name, and by its glued or punctuated spelling", () => {
        tagRepo.ensureTag("tag", "Aunt Margaret", null, ADA);
        tagRepo.ensureTag("tag", "beach", null, ADA);

        for (const search of [
            "margaret",
            "auntmargaret",
            "aunt.margaret",
            "aunt+margaret",
            "auntmarg",
        ]) {
            expect(names(page(null, { search })), search).toEqual(["Aunt Margaret"]);
        }
    });

    it("finds a misspelling when nothing is spelled that way", () => {
        tagRepo.ensureTag("tag", "Aunt Margaret", null, ADA);
        tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(names(page(null, { search: "margret" }))).toEqual(["Aunt Margaret"]);
        expect(names(page(null, { search: "auntmargret" }))).toEqual(["Aunt Margaret"]);
    });

    /** A close spelling beside an exact one is how fuzzy search buries what was typed. */
    it("does not add near spellings to a search that matched", () => {
        tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.ensureTag("tag", "bench", null, ADA);

        expect(names(page(null, { search: "bench" }))).toEqual(["bench"]);
        expect(names(page(null, { search: "bech" }))).toEqual(["beach", "bench"]);
    });

    it("never fuzzes into the other system's vocabulary", () => {
        tagRepo.ensureTag("tag", "margaret", BEN, BEN);

        expect(names(page(null, { search: "margret" }))).toEqual([]);
    });

    /** A search for "50%" must not become a search for everything. */
    it("treats a wildcard as a character", () => {
        tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(names(page(null, { search: "%" }))).toEqual(["beach"]);
    });

    it("filters to one facet", () => {
        tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.ensureTag("performer", "alice", null, ADA);

        expect(names(page(null, { kind: "performer" }))).toEqual(["alice"]);
    });

    it("finds the tags nothing carries", () => {
        const used = tagRepo.ensureTag("tag", "used", null, ADA);

        tagRepo.ensureTag("tag", "unused", null, ADA);
        tagIt(givenMedia("m1"), used, null, ADA);

        expect(names(page(null, { unusedOnly: true }))).toEqual(["unused"]);
    });

    /**
     * The count has to match what clicking it returns. Raw assignments include trashed and
     * archived items, so a tag promising 412 and delivering 380 reads as broken data rather
     * than as two different questions.
     */
    it("counts only items the library would show", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);

        tagIt(givenMedia("shown"), tag, null, ADA);
        tagIt(givenMedia("hidden", false), tag, null, ADA);

        expect(page(null).rows[0].mediaCount).toBe(1);
    });

    it("pages, and reports the total behind the page", () => {
        for (const name of ["a", "b", "c", "d"]) {
            tagRepo.ensureTag("tag", name, null, ADA);
        }

        const first = tagRepo.listVocabulary(null, { limit: 2, offset: 0 });

        expect(names(first)).toEqual(["a", "b"]);
        expect(first.total).toBe(4);
        expect(names(tagRepo.listVocabulary(null, { limit: 2, offset: 2 }))).toEqual(["c", "d"]);
    });

    /**
     * By count across the whole facet, not within a page: the sort is the query's, so the
     * busiest tag is first even when its name would put it on the last page. Ties fall back
     * to the name, so a page boundary never lands somewhere arbitrary.
     */
    it("sorts by count when asked, with the name breaking ties", () => {
        const busy = tagRepo.ensureTag("tag", "zebra", null, ADA);
        const some = tagRepo.ensureTag("tag", "yak", null, ADA);
        tagRepo.ensureTag("tag", "b", null, ADA);
        tagRepo.ensureTag("tag", "a", null, ADA);

        tagIt(givenMedia("m1"), busy, null, ADA);
        tagIt(givenMedia("m2"), busy, null, ADA);
        tagIt(givenMedia("m3"), some, null, ADA);

        expect(names(page(null))).toEqual(["a", "b", "yak", "zebra"]);
        expect(names(tagRepo.listVocabulary(null, { limit: 1, offset: 0, sort: "count" }))).toEqual(
            ["zebra"]
        );
        expect(names(page(null, { sort: "count" }))).toEqual(["zebra", "yak", "a", "b"]);
    });

    /** The total is counted after the HAVING, or "showing 2 of 40" is a different 40. */
    it("counts the filtered total, not the whole vocabulary", () => {
        const used = tagRepo.ensureTag("tag", "used", null, ADA);

        tagRepo.ensureTag("tag", "unused", null, ADA);
        tagIt(givenMedia("m1"), used, null, ADA);

        expect(tagRepo.listVocabulary(null, { limit: 50, offset: 0, unusedOnly: true }).total).toBe(
            1
        );
    });

    it("names whoever coined it", () => {
        tagRepo.ensureTag("tag", "beach", null, BEN);

        expect(page(null).rows[0].createdBy).toBe("Ben");
    });

    /** A public tag belongs to the library, so losing its author must not take the name. */
    it("keeps a public tag when the account that coined it is deleted", () => {
        tagRepo.ensureTag("tag", "beach", null, BEN);

        db.prepare(`DELETE FROM "User" WHERE "id" = ?`).run(BEN);

        expect(names(page(null))).toEqual(["beach"]);
        expect(page(null).rows[0].createdBy).toBeNull();
    });

    /** The second person to type a name did not coin it. */
    it("does not reattribute an existing tag to whoever used it next", () => {
        tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.ensureTag("tag", "beach", null, BEN);

        expect(page(null).rows[0].createdBy).toBe("Ada");
    });
});

describe("moving a tag between the two systems", () => {
    it("moves the tag and every assignment together", () => {
        const tag = tagRepo.ensureTag("tag", "beach", ADA, ADA);

        tagIt(givenMedia("m1"), tag, ADA, ADA);

        expect(tagRepo.setScope(tag, null)).toEqual(["m1"]);
        expect(tagRepo.findById(tag)?.ownerId).toBeNull();
        expect(db.prepare(`SELECT "userId" FROM "MediaTag" WHERE "tagId" = ?`).get(tag)).toEqual({
            userId: null,
        });
    });

    /**
     * The invariant is the point. If the two halves could disagree even briefly, a read in
     * between would report a private tag on an assignment everybody can see — and `assign`
     * would then refuse to write anything more to it.
     */
    it("leaves the scope invariant satisfied afterwards", () => {
        const tag = tagRepo.ensureTag("tag", "beach", ADA, ADA);

        tagIt(givenMedia("m1"), tag, ADA, ADA);
        tagRepo.setScope(tag, null);

        expect(() =>
            tagRepo.assign({
                mediaId: givenMedia("m2"),
                tagId: tag,
                userId: null,
                createdById: BEN,
            })
        ).not.toThrow();
    });

    it("carries the assignments into an existing tag when the name is taken", () => {
        const mine = tagRepo.ensureTag("tag", "beach", ADA, ADA);
        const shared = tagRepo.ensureTag("tag", "beach", null, BEN);

        tagIt(givenMedia("m1"), mine, ADA, ADA);

        expect(tagRepo.moveAssignments(mine, shared, null)).toEqual(["m1"]);
        expect(tagRepo.findById(mine)).toBeUndefined();
        expect(tagRepo.listForMedia("m1", ADA).map((row) => row.tagId)).toEqual([shared]);
    });

    it("does not duplicate an assignment the destination already had", () => {
        const mine = tagRepo.ensureTag("tag", "beach", ADA, ADA);
        const shared = tagRepo.ensureTag("tag", "beach", null, BEN);
        const media = givenMedia("m1");

        tagIt(media, mine, ADA, ADA);
        tagIt(media, shared, null, BEN);
        tagRepo.moveAssignments(mine, shared, null);

        expect(
            db.prepare(`SELECT count(*) AS n FROM "MediaTag" WHERE "mediaId" = ?`).get(media)
        ).toEqual({ n: 1 });
    });
});

describe("whether anybody else has used a tag", () => {
    it("is false while you are the only one", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);

        tagIt(givenMedia("m1"), tag, null, ADA);

        expect(tagRepo.hasAssignmentsByOthers(tag, ADA)).toBe(false);
    });

    it("is true once somebody else has", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);

        tagIt(givenMedia("m1"), tag, null, ADA);
        tagIt(givenMedia("m2"), tag, null, BEN);

        expect(tagRepo.hasAssignmentsByOthers(tag, ADA)).toBe(true);
    });

    /**
     * An unattributed row counts as somebody else's. It predates attribution or its account is
     * gone, and either way it is not evidence that you were alone — which is the only thing
     * that makes unpublishing safe.
     */
    it("treats an unattributed assignment as somebody else's", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);

        tagIt(givenMedia("m1"), tag, null, BEN);
        db.prepare(`DELETE FROM "User" WHERE "id" = ?`).run(BEN);

        expect(tagRepo.hasAssignmentsByOthers(tag, ADA)).toBe(true);
    });
});
