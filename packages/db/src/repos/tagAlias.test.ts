import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Aliases: other names for a tag (§5b "Aliases").
 *
 * The rule everything here leans on is that within one vocabulary -- one facet, one owner -- a
 * normalised name belongs to at most one tag, as its name or as an alias. `ensureTag` depends
 * on it to know which tag a typed name means, so most of these tests are about what keeps it
 * true: adding aliases, merging, and moving a tag between the two systems.
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
        DELETE FROM "TagAlias"; DELETE FROM "MediaTag"; DELETE FROM "Tag"; DELETE FROM "Media";
        DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                (?, 'ben@example.test', 'Ben', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA, BEN);
});

const givenMedia = (id: string): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "updatedAt")
         VALUES (?, 'video', ?, 1, CURRENT_TIMESTAMP)`
    ).run(id, id);

    return id;
};

const tagIt = (mediaId: string, tagId: string, owner: string | null): void => {
    tagRepo.assign({ mediaId, tagId, userId: owner, createdById: ADA });
};

const aliasesOf = (tagId: string): string[] => tagRepo.aliasesByTag([tagId]).get(tagId) ?? [];

describe("resolving a typed name", () => {
    it("makes ensureTag answer an alias with the tag that holds it", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Jane Smith"], ADA);

        expect(tagRepo.ensureTag("performer", "jane  smith", null, BEN)).toBe(jane);
        expect(db.prepare(`SELECT count(*) AS n FROM "Tag"`).get()).toEqual({ n: 1 });
    });

    it("keeps an alias to its own facet and its own vocabulary", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Smith"], ADA);

        expect(tagRepo.ensureTag("tag", "Smith", null, ADA)).not.toBe(jane);
        expect(tagRepo.ensureTag("tag", "Smith", ADA, ADA)).not.toBe(jane);
    });

    it("says whether a name matched by name or by alias", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Jane Smith"], ADA);

        expect(tagRepo.resolveName("performer", "Jane Doe", null)?.via).toBe("name");
        expect(tagRepo.resolveName("performer", "Jane Smith", null)).toMatchObject({
            via: "alias",
            tag: { id: jane },
        });
        expect(tagRepo.resolveName("performer", "Jane Smith", ADA)).toBeUndefined();
    });
});

describe("setAliases", () => {
    it("replaces the whole set, keeping rows that survive", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.setAliases(tag, ["seaside", "shore"], ADA);

        const before = db
            .prepare(`SELECT "id" FROM "TagAlias" WHERE "nameNorm" = 'seaside'`)
            .get() as { id: string };

        tagRepo.setAliases(tag, ["Seaside", "coast"], BEN);

        expect(aliasesOf(tag)).toEqual(["coast", "Seaside"]);
        expect(
            db
                .prepare(`SELECT "id", "createdById" FROM "TagAlias" WHERE "nameNorm" = 'seaside'`)
                .get()
        ).toEqual({ id: before.id, createdById: ADA });
    });

    it("drops an alias that is the tag's own name, and duplicates", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.setAliases(tag, ["Beach", "shore", "SHORE"], ADA);

        expect(aliasesOf(tag)).toEqual(["shore"]);
    });

    it("refuses another tag's name in the same vocabulary", () => {
        tagRepo.ensureTag("tag", "coast", null, ADA);
        const beach = tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(() => tagRepo.setAliases(beach, ["Coast"], ADA)).toThrow(/merge instead/);
    });

    it("refuses another tag's alias, naming the tag that has it", () => {
        const coast = tagRepo.ensureTag("tag", "coast", null, ADA);
        tagRepo.setAliases(coast, ["shore"], ADA);
        const beach = tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(() => tagRepo.setAliases(beach, ["shore"], ADA)).toThrow(
            '"shore" is already an alias of coast'
        );
    });

    it("allows the same alias in the other system", () => {
        const library = tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.setAliases(library, ["shore"], ADA);
        const mine = tagRepo.ensureTag("tag", "coast", ADA, ADA);

        tagRepo.setAliases(mine, ["shore"], ADA);

        expect(aliasesOf(mine)).toEqual(["shore"]);
    });

    it("refuses a name with nothing to normalise", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(() => tagRepo.setAliases(tag, ["!!!"], ADA)).toThrow(/letter or digit/);
    });
});

describe("mergeTags", () => {
    it("moves the source's aliases and keeps its name when asked", () => {
        const doe = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        const smith = tagRepo.ensureTag("performer", "Jane Smith", null, ADA);
        tagRepo.setAliases(smith, ["J. Smith"], ADA);

        tagRepo.mergeTags(smith, doe, { keepAlias: true, createdById: BEN });

        expect(aliasesOf(doe)).toEqual(["J. Smith", "Jane Smith"]);
        expect(tagRepo.ensureTag("performer", "Jane Smith", null, ADA)).toBe(doe);
    });

    it("forgets the source's name when not asked to keep it", () => {
        const beach = tagRepo.ensureTag("tag", "beach", null, ADA);
        const typo = tagRepo.ensureTag("tag", "baech", null, ADA);
        tagRepo.setAliases(typo, ["bech"], ADA);

        tagRepo.mergeTags(typo, beach);

        expect(aliasesOf(beach)).toEqual(["bech"]);
        expect(tagRepo.resolveName("tag", "baech", null)).toBeUndefined();
    });
});

describe("moving between the two systems", () => {
    it("carries aliases with a tag that moves, less those the destination uses", () => {
        const library = tagRepo.ensureTag("tag", "coast", null, ADA);
        tagRepo.setAliases(library, ["shore"], ADA);
        const mine = tagRepo.ensureTag("tag", "beach", ADA, ADA);
        tagRepo.setAliases(mine, ["shore", "seaside"], ADA);

        expect(tagRepo.dropClashingAliases(mine, null)).toBe(1);
        tagRepo.setScope(mine, null);

        expect(aliasesOf(mine)).toEqual(["seaside"]);
        expect(tagRepo.resolveName("tag", "seaside", null)?.tag.id).toBe(mine);
    });

    it("folds aliases into the tag a publish lands on, without counting ones it already has", () => {
        const library = tagRepo.ensureTag("tag", "beach", null, ADA);
        tagRepo.setAliases(library, ["shore"], ADA);
        const mine = tagRepo.ensureTag("tag", "beach", ADA, ADA);
        tagRepo.setAliases(mine, ["shore", "seaside"], ADA);
        tagIt(givenMedia("m1"), mine, ADA);

        expect(tagRepo.dropClashingAliases(mine, null, library)).toBe(0);
        tagRepo.moveAssignments(mine, library, null);

        expect(aliasesOf(library)).toEqual(["seaside", "shore"]);
    });
});

describe("finding a tag by typing", () => {
    it("matches an alias in the vocabulary search and says which tag it found", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Jane Smith"], ADA);
        tagRepo.ensureTag("performer", "Someone Else", null, ADA);

        const { rows, total } = tagRepo.listVocabulary(null, {
            search: "jane sm",
            limit: 50,
            offset: 0,
        });

        expect(total).toBe(1);
        expect(rows[0]).toMatchObject({ name: "Jane Doe", aliases: ["Jane Smith"] });
    });

    it("matches an alias among the facet values", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Jane Smith"], ADA);
        tagIt(givenMedia("m1"), jane, null);

        const values = tagRepo.listFacetValues({ owner: null, search: "jane sm", limit: 20 });

        expect(values.map((value) => value.tagId)).toEqual([jane]);
    });

    it("carries aliases on the picker's list, and an empty list when there are none", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Jane Smith", "J. Doe"], ADA);
        tagRepo.ensureTag("performer", "Plain", null, ADA);

        const listed = tagRepo.listByKind("performer", null);

        expect(listed.find((row) => row.id === jane)?.aliases).toEqual(["J. Doe", "Jane Smith"]);
        expect(listed.find((row) => row.name === "Plain")?.aliases).toEqual([]);
    });
});

describe("deleting a tag", () => {
    it("takes its aliases with it, so the name is free again", () => {
        const jane = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);
        tagRepo.setAliases(jane, ["Jane Smith"], ADA);

        tagRepo.removeTag(jane);

        expect(tagRepo.ensureTag("performer", "Jane Smith", null, ADA)).not.toBe(jane);
    });
});
