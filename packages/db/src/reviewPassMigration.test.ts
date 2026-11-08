import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { down, up } from "./migrations/20261108_140000_review_passes.js";

/**
 * The single reviewed flag becoming a "Reviewed" pass per person per room (§14d).
 *
 * Built by replaying every migration before this one, so the database it runs on is the one a
 * real install has: `UserMedia.reviewedAt` with marks in it, and saved views asking about it.
 */

const MIGRATION = "20261108_140000_review_passes";
const here = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

const replayBefore = async (database: Database.Database): Promise<void> => {
    const dir = path.join(here, "migrations");
    const files = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(".ts") && file < MIGRATION)
        .sort();

    for (const file of files) {
        const migration = (await import(pathToFileURL(path.join(dir, file)).href)) as {
            up: (db: Database.Database) => void;
        };

        migration.up(database);
    }
};

const item = (id: string, rootId: string | null): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "listRootId", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
    ).run(id, rootId);
};

const reviewed = (userId: string, mediaId: string, at: string | null): void => {
    db.prepare(
        `INSERT INTO "UserMedia" ("userId", "mediaId", "reviewedAt", "rating", "updatedAt")
         VALUES (?, ?, ?, 3, CURRENT_TIMESTAMP)`
    ).run(userId, mediaId, at);
};

const savedView = (id: string, userId: string, domain: string, query: object): void => {
    db.prepare(
        `INSERT INTO "SavedFilter" ("id", "userId", "domain", "name", "queryJson", "updatedAt")
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, userId, domain, id, JSON.stringify(query));
};

const queryOf = (id: string): Record<string, unknown> =>
    JSON.parse(
        (
            db.prepare(`SELECT "queryJson" FROM "SavedFilter" WHERE "id" = ?`).get(id) as {
                queryJson: string;
            }
        ).queryJson
    ) as Record<string, unknown>;

const passes = () =>
    db
        .prepare(
            `SELECT "ownerId", "domain", "name" FROM "ReviewPass" ORDER BY "ownerId", "domain"`
        )
        .all();

const passId = (ownerId: string, domain: string): string =>
    (
        db
            .prepare(`SELECT "id" FROM "ReviewPass" WHERE "ownerId" = ? AND "domain" = ?`)
            .get(ownerId, domain) as { id: string }
    ).id;

const marks = () =>
    db
        .prepare(
            `SELECT p."ownerId", p."domain", rm."mediaId", rm."reviewedAt"
               FROM "ReviewMark" rm JOIN "ReviewPass" p ON p."id" = rm."passId"
              ORDER BY p."ownerId", rm."mediaId"`
        )
        .all();

const hasColumn = (): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('UserMedia') WHERE "name" = 'reviewedAt'`).get() !==
    undefined;

beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    await replayBefore(db);

    db.exec(`
        INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt") VALUES
            ('u1', 'u1@example.test', 'U1', 'x', CURRENT_TIMESTAMP),
            ('u2', 'u2@example.test', 'U2', 'x', CURRENT_TIMESTAMP),
            ('u3', 'u3@example.test', 'U3', 'x', CURRENT_TIMESTAMP);
        INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "domain", "updatedAt") VALUES
            ('cellar', '/media/c', 'C', 1, 'cellar', CURRENT_TIMESTAMP),
            ('games', '/media/g', 'G', 1, 'games', CURRENT_TIMESTAMP);
    `);

    item("c1", "cellar");
    item("g1", "games");
    item("g2", "games");
    // No original left: the cellar's, as everything before rooms was.
    item("orphan", null);

    reviewed("u1", "c1", "2026-11-01 10:00:00");
    reviewed("u1", "g1", "2026-11-02 10:00:00");
    reviewed("u1", "g2", null);
    reviewed("u2", "orphan", "2026-11-03 10:00:00");

    savedView("backlog", "u1", "games", { reviewed: "no", sort: "addedAt" });
    savedView("done", "u1", "cellar", { reviewed: "yes" });
    // u3 marked nothing, so has no pass: the condition goes, the rest of the view stays.
    savedView("nothing", "u3", "games", { reviewed: "no", favorite: true });
    savedView("plain", "u1", "games", { favorite: true });
});

describe("review passes from the reviewed flag", () => {
    it("makes a Reviewed pass per person per room their marked items are in", () => {
        up(db);

        expect(passes()).toEqual([
            { ownerId: "u1", domain: "cellar", name: "Reviewed" },
            { ownerId: "u1", domain: "games", name: "Reviewed" },
            { ownerId: "u2", domain: "cellar", name: "Reviewed" },
        ]);
    });

    it("moves each mark into its room's pass with its date, and drops the column", () => {
        up(db);

        expect(marks()).toEqual([
            {
                ownerId: "u1",
                domain: "cellar",
                mediaId: "c1",
                reviewedAt: "2026-11-01 10:00:00",
            },
            { ownerId: "u1", domain: "games", mediaId: "g1", reviewedAt: "2026-11-02 10:00:00" },
            {
                ownerId: "u2",
                domain: "cellar",
                mediaId: "orphan",
                reviewedAt: "2026-11-03 10:00:00",
            },
        ]);
        expect(hasColumn()).toBe(false);
        // The rest of the row is untouched.
        expect(db.prepare(`SELECT "rating" FROM "UserMedia" WHERE "mediaId" = 'g2'`).get()).toEqual(
            { rating: 3 }
        );
    });

    it("points saved views at the pass, or drops the condition where there is none", () => {
        up(db);

        expect(queryOf("backlog")).toEqual({
            sort: "addedAt",
            notReviewedFor: [passId("u1", "games")],
        });
        expect(queryOf("done")).toEqual({ reviewedFor: [passId("u1", "cellar")] });
        expect(queryOf("nothing")).toEqual({ favorite: true });
        expect(queryOf("plain")).toEqual({ favorite: true });
    });

    it("is idempotent", () => {
        up(db);
        const before = { passes: passes(), marks: marks(), backlog: queryOf("backlog") };

        up(db);

        expect({ passes: passes(), marks: marks(), backlog: queryOf("backlog") }).toEqual(before);
    });

    it("puts the column, its marks and the saved views back on the way down", () => {
        up(db);
        // A second pass marking the same item earlier: down keeps the earliest mark.
        db.prepare(
            `INSERT INTO "ReviewPass" ("id", "ownerId", "domain", "name", "updatedAt")
             VALUES ('wins', 'u1', 'games', 'Wins', CURRENT_TIMESTAMP)`
        ).run();
        db.prepare(
            `INSERT INTO "ReviewMark" ("passId", "mediaId", "reviewedAt")
             VALUES ('wins', 'g1', '2026-10-30 10:00:00'), ('wins', 'g2', '2026-11-04 10:00:00')`
        ).run();

        down(db);

        expect(hasColumn()).toBe(true);
        expect(
            db
                .prepare(
                    `SELECT "userId", "mediaId", "reviewedAt", "rating" FROM "UserMedia"
                      ORDER BY "userId", "mediaId"`
                )
                .all()
        ).toEqual([
            { userId: "u1", mediaId: "c1", reviewedAt: "2026-11-01 10:00:00", rating: 3 },
            { userId: "u1", mediaId: "g1", reviewedAt: "2026-10-30 10:00:00", rating: 3 },
            { userId: "u1", mediaId: "g2", reviewedAt: "2026-11-04 10:00:00", rating: 3 },
            { userId: "u2", mediaId: "orphan", reviewedAt: "2026-11-03 10:00:00", rating: 3 },
        ]);
        expect(queryOf("backlog")).toEqual({ sort: "addedAt", reviewed: "no" });
        expect(queryOf("done")).toEqual({ reviewed: "yes" });
        expect(
            db
                .prepare(
                    `SELECT "name" FROM sqlite_master WHERE "name" IN ('ReviewPass', 'ReviewMark')`
                )
                .all()
        ).toEqual([]);
    });
});
