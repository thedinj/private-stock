import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Favourite tags (§6 "Favourite tags"), against a real database and two real accounts.
 *
 * Two people because the mark is one person's: Ada's favourite performer is nothing to Ben. The
 * rest is what happens to a mark when the tag under it changes -- merged, published onto an
 * existing name, made private, emptied, deleted -- because each of those used to be a plain
 * `DELETE FROM "Tag"` that a favourite would have silently gone with.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagRepo = await import("./tagRepo.js");
const userTagRepo = await import("./userTagRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADA = "u-ada";
const BEN = "u-ben";
const MEDIA = "m1";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "UserTag"; DELETE FROM "MediaTag"; DELETE FROM "TagAlias"; DELETE FROM "Tag";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                (?, 'ben@example.test', 'Ben', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA, BEN);
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
         VALUES (?, 'video', 'Test', 1, 'root', CURRENT_TIMESTAMP)`
    ).run(MEDIA);
});

/** A tag carried by the one item, so browsing can see it. */
const tagged = (kind: string, name: string, owner: string | null): string => {
    const tagId = tagRepo.ensureTag(kind, name, owner);

    tagRepo.assign({ mediaId: MEDIA, tagId, userId: owner, createdById: owner ?? ADA });

    return tagId;
};

const browse = (viewerId: string, favorite?: boolean) =>
    tagRepo
        .browseTags(null, {
            kind: "performer",
            sort: "name",
            viewerId,
            rootIds: ["root"],
            favorite,
            limit: 30,
            offset: 0,
        })
        .rows.map((row) => [row.name, row.favorite]);

describe("the mark", () => {
    it("is one person's, and survives being taken back and given again", () => {
        const dad = tagged("performer", "Dad", null);

        userTagRepo.setFavorite(ADA, dad, true);
        expect(userTagRepo.isFavorite(ADA, dad)).toBe(true);
        expect(userTagRepo.isFavorite(BEN, dad)).toBe(false);

        userTagRepo.setFavorite(ADA, dad, false);
        expect(userTagRepo.isFavorite(ADA, dad)).toBe(false);
        // NULL, never 0: the partial index depends on it.
        expect(db.prepare(`SELECT "favorite" FROM "UserTag" WHERE "tagId" = ?`).get(dad)).toEqual({
            favorite: null,
        });

        userTagRepo.setFavorite(ADA, dad, true);
        expect(userTagRepo.isFavorite(ADA, dad)).toBe(true);
    });
});

describe("browsing", () => {
    it("marks each viewer's own favourites, and filters to them on request", () => {
        const dad = tagged("performer", "Dad", null);
        const mum = tagged("performer", "Mum", null);

        userTagRepo.setFavorite(ADA, dad, true);
        userTagRepo.setFavorite(BEN, mum, true);

        expect(browse(ADA)).toEqual([
            ["Dad", 1],
            ["Mum", null],
        ]);
        expect(browse(BEN)).toEqual([
            ["Dad", null],
            ["Mum", 1],
        ]);
        expect(browse(ADA, true)).toEqual([["Dad", 1]]);
        expect(browse(BEN, true)).toEqual([["Mum", 1]]);
        expect(
            tagRepo.browseTags(null, {
                kind: "performer",
                sort: "name",
                viewerId: ADA,
                rootIds: ["root"],
                favorite: true,
                limit: 30,
                offset: 0,
            }).total
        ).toBe(1);
    });
});

describe("when the tag changes under the mark", () => {
    it("follows a merge, keeping a favourite either side carried", () => {
        const misspelt = tagged("performer", "Dadd", null);
        const dad = tagged("performer", "Dad", null);

        userTagRepo.setFavorite(ADA, misspelt, true);
        // Ben marked both and then unmarked the target: still a favourite once they are one.
        userTagRepo.setFavorite(BEN, misspelt, true);
        userTagRepo.setFavorite(BEN, dad, false);

        tagRepo.mergeTags(misspelt, dad);

        expect(userTagRepo.isFavorite(ADA, dad)).toBe(true);
        expect(userTagRepo.isFavorite(BEN, dad)).toBe(true);
        expect(db.prepare(`SELECT count(*) AS n FROM "UserTag"`).get()).toEqual({ n: 2 });
    });

    it("follows a private tag published onto an existing public name", () => {
        const mine = tagged("tag", "beach", ADA);
        const library = tagged("tag", "beach", null);

        userTagRepo.setFavorite(ADA, mine, true);
        tagRepo.moveAssignments(mine, library, null);

        expect(userTagRepo.isFavorite(ADA, library)).toBe(true);
    });

    it("leaves only the new owner's mark on a tag made private", () => {
        const beach = tagged("tag", "beach", null);

        userTagRepo.setFavorite(ADA, beach, true);
        userTagRepo.setFavorite(BEN, beach, true);
        tagRepo.setScope(beach, ADA);

        expect(userTagRepo.isFavorite(ADA, beach)).toBe(true);
        expect(userTagRepo.isFavorite(BEN, beach)).toBe(false);
    });

    it("keeps a favourite tag whose last item was taken from it", () => {
        const dad = tagged("performer", "Dad", null);
        const mum = tagged("performer", "Mum", null);

        userTagRepo.setFavorite(ADA, dad, true);
        // `unassign` prunes what it emptied.
        tagRepo.unassign(MEDIA, dad, null);
        tagRepo.unassign(MEDIA, mum, null);

        expect(tagRepo.findById(dad)).toBeDefined();
        expect(tagRepo.findById(mum)).toBeUndefined();
    });

    it("goes with the tag when it is deleted", () => {
        const dad = tagged("performer", "Dad", null);

        userTagRepo.setFavorite(ADA, dad, true);
        tagRepo.removeTag(dad);

        expect(db.prepare(`SELECT count(*) AS n FROM "UserTag"`).get()).toEqual({ n: 0 });
    });
});
