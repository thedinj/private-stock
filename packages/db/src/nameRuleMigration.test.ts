import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { normalizeName } from "@private-stock/core";

import { initializeDatabase } from "./init.js";
import { down, up } from "./migrations/20261006_180000_name_rule.js";

/**
 * Stored names moving to the one rule for names (§5b). The data is the whole migration, so it
 * runs against a real database.
 */

let db: Database.Database;

const addTag = (id: string, name: string, nameNorm: string, kind = "performer"): void => {
    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, kind, name, nameNorm);
};

const addAlias = (id: string, tagId: string, name: string, nameNorm: string): void => {
    db.prepare(
        `INSERT INTO "TagAlias" ("id", "tagId", "name", "nameNorm") VALUES (?, ?, ?, ?)`
    ).run(id, tagId, name, nameNorm);
};

const norm = (table: "Tag" | "TagAlias", id: string): string =>
    (db.prepare(`SELECT "nameNorm" FROM "${table}" WHERE "id" = ?`).get(id) as { nameNorm: string })
        .nameNorm;

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
});

describe("the one rule for names, stored", () => {
    it("restores what the old rule glued or kept, and agrees with normalizeName", () => {
        addTag("mk", "Mary-Kate", "marykate");
        addTag("zoe", "Zoë", "zoë");
        addTag("site", "examplesite.com", "examplesitecom", "source");
        addTag("plain", "Jane Doe", "jane doe");
        addAlias("a1", "mk", "M.K. Olsen", "mk olsen");

        up(db);

        expect(norm("Tag", "mk")).toBe("mary kate");
        expect(norm("Tag", "zoe")).toBe("zoe");
        expect(norm("Tag", "site")).toBe("examplesite com");
        expect(norm("Tag", "plain")).toBe("jane doe");
        expect(norm("TagAlias", "a1")).toBe("m k olsen");

        for (const [id, name] of [
            ["mk", "Mary-Kate"],
            ["zoe", "Zoë"],
            ["site", "examplesite.com"],
        ]) {
            expect(norm("Tag", id)).toBe(normalizeName(name));
        }
    });

    it("leaves a row whose new form is taken, rather than failing", () => {
        addTag("glued", "Mary-Kate", "marykate");
        addTag("spaced", "Mary Kate", "mary kate");

        up(db);

        expect(norm("Tag", "glued")).toBe("marykate");
        expect(norm("Tag", "spaced")).toBe("mary kate");
    });

    it("goes back down to the old forms, and is idempotent", () => {
        addTag("mk", "Mary-Kate", "marykate");

        up(db);
        up(db);
        expect(norm("Tag", "mk")).toBe("mary kate");

        down(db);
        expect(norm("Tag", "mk")).toBe("marykate");
    });
});
