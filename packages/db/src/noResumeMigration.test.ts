import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { homeLayoutSchema } from "@private-stock/core";

import { initializeDatabase } from "./init.js";
import { down, up } from "./migrations/20261010_090000_no_resume.js";

/**
 * Stored home layouts moving off the `continueWatching` shelf (§14b). A layout that no longer
 * parses falls back to the default wholesale, so this is the part of the migration that would
 * lose somebody's arrangement if it were wrong.
 */

let db: Database.Database;

const OLD_LAYOUT = JSON.stringify([
    { source: "builtin", builtin: "continueWatching", title: '"continueWatching"', limit: 8 },
    { source: "builtin", builtin: "random", limit: 12 },
]);

const layoutOf = (userId: string): string =>
    (
        db.prepare(`SELECT "rowsJson" FROM "HomeLayout" WHERE "userId" = ?`).get(userId) as {
            rowsJson: string;
        }
    ).rowsJson;

const defaultLayout = (): string =>
    (
        db.prepare(`SELECT "value" FROM "Setting" WHERE "key" = 'home.defaultLayout'`).get() as {
            value: string;
        }
    ).value;

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES ('u1', 'u1@example.test', 'U1', 'x', CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "HomeLayout" ("userId", "rowsJson", "updatedAt")
         VALUES ('u1', ?, CURRENT_TIMESTAMP)`
    ).run(OLD_LAYOUT);
    db.prepare(
        `INSERT INTO "Setting" ("key", "value", "updatedAt")
         VALUES ('home.defaultLayout', ?, CURRENT_TIMESTAMP)`
    ).run(OLD_LAYOUT);
});

describe("no resume points, stored", () => {
    it("renames the shelf in every layout and leaves a title that merely mentions it", () => {
        up(db);

        for (const raw of [layoutOf("u1"), defaultLayout()]) {
            const layout = homeLayoutSchema.parse(JSON.parse(raw));

            expect(layout[0]).toMatchObject({
                builtin: "recentlyViewed",
                title: '"continueWatching"',
                limit: 8,
            });
        }
    });

    it("puts the old name back on the way down", () => {
        up(db);
        down(db);

        expect(layoutOf("u1")).toBe(OLD_LAYOUT);
        expect(defaultLayout()).toBe(OLD_LAYOUT);
    });
});
