import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * One vocabulary per room (§21 "One vocabulary per room").
 *
 * Tags hang off no library, so narrowing a request to one room's libraries does not reach them:
 * every read and write of the vocabulary names its room instead. What these guard is that the
 * same name in two rooms is two tags, that nothing which turns a typed name into a tag looks in
 * another room, and that no list of names offers another room's.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagRepo = await import("./tagRepo.js");
const tagBatchRepo = await import("./tagBatchRepo.js");
const mentionRepo = await import("./mentionRepo.js");
const mediaRepo = await import("./mediaRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADA = "u-ada";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "TagAlias"; DELETE FROM "MediaTag"; DELETE FROM "UserTag"; DELETE FROM "Tag";
        DELETE FROM "Media"; DELETE FROM "MediaRoot"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "domain", "updatedAt")
         VALUES ('r-cellar', '/media/cellar', 'Cellar', 1, 'cellar', CURRENT_TIMESTAMP),
                ('r-home', '/media/home', 'Home', 1, 'family', CURRENT_TIMESTAMP)`
    ).run();
});

/** An item in one library; `listRootId` is what says its room. */
const givenMedia = (id: string, rootId: string): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
         VALUES (?, 'video', ?, 1, ?, CURRENT_TIMESTAMP)`
    ).run(id, id, rootId);

    return id;
};

const tagIt = (mediaId: string, tagId: string): void =>
    tagRepo.assign({ mediaId, tagId, userId: null, createdById: ADA });

describe("names", () => {
    it("lets the same name be a tag in two rooms", () => {
        const cellar = tagRepo.ensureTag("cellar", "performer", "Jane", null, ADA);
        const home = tagRepo.ensureTag("family", "performer", "Jane", null, ADA);

        expect(home).not.toBe(cellar);
        expect(tagRepo.ensureTag("family", "performer", "jane", null, ADA)).toBe(home);
        expect(tagRepo.findById(home)?.domain).toBe("family");
    });

    it("resolves a name, and an alias, in its own room only", () => {
        const cellar = tagRepo.ensureTag("cellar", "performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(cellar, ["Jane Smith"], ADA);

        expect(tagRepo.resolveName("cellar", "performer", "Jane Smith", null)?.tag.id).toBe(cellar);
        expect(tagRepo.resolveName("family", "performer", "Jane Doe", null)).toBeUndefined();
        expect(tagRepo.resolveName("family", "performer", "Jane Smith", null)).toBeUndefined();

        // Typing the Cellar's alias in the Parlour coins the Parlour's own name.
        expect(tagRepo.ensureTag("family", "performer", "Jane Smith", null, ADA)).not.toBe(cellar);
    });

    it("lets each room give a name as an alias without the other's clashing", () => {
        const cellar = tagRepo.ensureTag("cellar", "performer", "Jane Doe", null, ADA);
        const home = tagRepo.ensureTag("family", "performer", "Mum", null, ADA);
        tagRepo.ensureTag("family", "performer", "Jane Smith", null, ADA);

        // "Jane Smith" is a Parlour name, which the Cellar's tag may still answer to.
        expect(() => tagRepo.setAliases(cellar, ["Jane Smith"], ADA)).not.toThrow();
        // And "Jane Doe" a Cellar name, which a Parlour tag may answer to.
        expect(() => tagRepo.setAliases(home, ["Jane Doe"], ADA)).not.toThrow();
    });

    it("refuses to merge tags of two rooms", () => {
        const cellar = tagRepo.ensureTag("cellar", "performer", "Jane", null, ADA);
        const home = tagRepo.ensureTag("family", "performer", "Jane", null, ADA);

        expect(() => tagRepo.mergeTags(home, cellar)).toThrow(ValidationError);
        expect(tagRepo.findById(home)).toBeDefined();
    });

    it("refuses to move one room's assignments onto another room's tag", () => {
        const cellar = tagRepo.ensureTag("cellar", "tag", "Beach", null, ADA);
        const mine = tagRepo.ensureTag("family", "tag", "Beach", ADA, ADA);

        expect(() => tagRepo.moveAssignments(mine, cellar, null)).toThrow(ValidationError);
    });
});

describe("assignments", () => {
    it("refuses a tag on an item of another room", () => {
        const item = givenMedia("home-1", "r-home");
        const cellar = tagRepo.ensureTag("cellar", "performer", "Jane", null, ADA);

        expect(() => tagIt(item, cellar)).toThrow(ValidationError);
        expect(() =>
            tagRepo.replaceFacet(item, "performer", [cellar], { userId: null, createdById: ADA })
        ).toThrow(ValidationError);
        expect(tagRepo.mediaIdsWithTag(cellar)).toEqual([]);
    });

    it("skips another room's pairs in a bulk apply and writes the rest", () => {
        const home = givenMedia("home-1", "r-home");
        const cellarItem = givenMedia("cellar-1", "r-cellar");
        const cellar = tagRepo.ensureTag("cellar", "tag", "Beach", null, ADA);

        const { assigned } = tagBatchRepo.apply({
            userId: ADA,
            scope: null,
            summary: "Beach",
            mediaIds: [home, cellarItem],
            tagIds: [cellar],
        });

        expect(assigned).toBe(1);
        expect(tagRepo.mediaIdsWithTag(cellar)).toEqual([cellarItem]);
    });

    it("copies a duplicate's tags only onto a survivor in the same room (§10c)", () => {
        const from = givenMedia("cellar-1", "r-cellar");
        const sameRoom = givenMedia("cellar-2", "r-cellar");
        const otherRoom = givenMedia("home-1", "r-home");
        const cellar = tagRepo.ensureTag("cellar", "tag", "Beach", null, ADA);
        tagIt(from, cellar);

        expect(tagRepo.copyAssignments(from, otherRoom)).toBe(0);
        expect(tagRepo.copyAssignments(from, sameRoom)).toBe(1);
        expect(tagRepo.mediaIdsWithTag(cellar).sort()).toEqual([from, sameRoom]);
    });
});

describe("lists of names", () => {
    beforeEach(() => {
        const cellarItem = givenMedia("cellar-1", "r-cellar");
        const homeItem = givenMedia("home-1", "r-home");

        tagIt(cellarItem, tagRepo.ensureTag("cellar", "performer", "Jane", null, ADA));
        tagIt(homeItem, tagRepo.ensureTag("family", "performer", "Mum", null, ADA));
        tagIt(homeItem, tagRepo.ensureTag("family", "performer", "Jane", null, ADA));
    });

    const names = (rows: { name: string }[]): string[] => rows.map((row) => row.name).sort();

    it("offers the filter panel one room's values", () => {
        expect(
            names(tagRepo.listFacetValues({ domain: "cellar", owner: null, limit: 20 }))
        ).toEqual(["Jane"]);
        expect(
            names(tagRepo.listFacetValues({ domain: "family", owner: null, limit: 20 }))
        ).toEqual(["Jane", "Mum"]);
        expect(
            names(
                tagRepo.listFacetValues({ domain: "cellar", owner: null, limit: 20, search: "mu" })
            )
        ).toEqual([]);
    });

    it("lists, searches and browses one room's vocabulary", () => {
        expect(names(tagRepo.listByKind("cellar", "performer", null))).toEqual(["Jane"]);
        expect(names(tagRepo.searchByKind("cellar", "performer", null, "mum", 10).rows)).toEqual(
            []
        );
        expect(names(tagRepo.searchByKind("family", "performer", null, "mum", 10).rows)).toEqual([
            "Mum",
        ]);
        expect(
            names(tagRepo.listVocabulary("family", null, { limit: 50, offset: 0 }).rows)
        ).toEqual(["Jane", "Mum"]);
        expect(
            names(
                tagRepo.browseTags("cellar", null, {
                    kind: "performer",
                    sort: "name",
                    viewerId: ADA,
                    rootIds: ["r-cellar", "r-home"],
                    limit: 50,
                    offset: 0,
                }).rows
            )
        ).toEqual(["Jane"]);
        expect(tagRepo.listKinds("games", ADA)).toEqual([]);
    });

    it("counts one room's favourites", () => {
        const mum = tagRepo.resolveName("family", "performer", "Mum", null)!.tag.id;
        db.prepare(
            `INSERT INTO "UserTag" ("userId", "tagId", "favorite", "updatedAt")
             VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
        ).run(ADA, mum);

        expect(mediaRepo.favoriteTagCount("family", ADA, "performer")).toEqual({ tags: 1 });
        expect(mediaRepo.favoriteTagCount("cellar", ADA, "performer")).toBeNull();
    });

    it("gives the name matcher and the word splitter one room's names", () => {
        expect(mentionRepo.vocabulary("cellar").map((entry) => entry.name)).toEqual(["Jane"]);
        expect(
            mentionRepo
                .vocabulary("family")
                .map((entry) => entry.name)
                .sort()
        ).toEqual(["Jane", "Mum"]);
        expect([...tagRepo.publicNameVocabulary("cellar").values()]).toEqual(["jane"]);
    });
});
