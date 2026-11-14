import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";
import { down, up } from "./migrations/20261113_120000_trash_in_place.js";

/**
 * Trashing in place (§10): the rebuild that makes `TrashEntry.trashRelPath` nullable.
 *
 * A table rebuild is the one kind of migration that can lose rows, and the entries it carries
 * are the only record of files the app has hidden but not yet deleted. So: every row survives,
 * an entry whose bytes did reach the old bin keeps its path, and one whose move never happened
 * loses it -- its file is still at the original path, which is what every entry looks like now.
 */

let db: Database.Database;

const insertEntry = (id: string, movedAt: string | null): void => {
    db.prepare(
        `INSERT INTO "TrashEntry"
             ("id", "mediaId", "fileId", "rootId", "relPath", "trashRelPath", "bytes",
              "deletedById", "purgeAfter", "movedAt")
         VALUES (?, NULL, NULL, 'r1', ?, ?, 1, 'u1', CURRENT_TIMESTAMP, ?)`
    ).run(id, `${id}.mp4`, `2026-11-01/${id}.mp4`, movedAt);
};

const pathOf = (id: string): string | null =>
    (
        db.prepare(`SELECT "trashRelPath" FROM "TrashEntry" WHERE "id" = ?`).get(id) as {
            trashRelPath: string | null;
        }
    ).trashRelPath;

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.pragma("foreign_keys = OFF");
    down(db);
    insertEntry("moved", "2026-11-01 00:00:00");
    insertEntry("unmoved", null);
});

describe("trash in place, stored", () => {
    it("keeps every entry, and the bin path only where the bytes reached the bin", () => {
        up(db);

        expect(db.prepare(`SELECT count(*) AS n FROM "TrashEntry"`).get()).toEqual({ n: 2 });
        expect(pathOf("moved")).toBe("2026-11-01/moved.mp4");
        expect(pathOf("unmoved")).toBeNull();
    });

    it("keeps the indexes the rebuild dropped", () => {
        up(db);

        const indexes = db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'index' AND "tbl_name" = 'TrashEntry' AND "sql" IS NOT NULL
                  ORDER BY "name"`
            )
            .all()
            .map((row) => (row as { name: string }).name);

        expect(indexes).toEqual([
            "idx_TrashEntry_deletedById",
            "idx_TrashEntry_fileId",
            "idx_TrashEntry_mediaId",
            "idx_TrashEntry_open_fileId",
            "idx_TrashEntry_pending",
            "idx_TrashEntry_purgeAfter",
            "idx_TrashEntry_twinFileId",
        ]);
    });

    it("runs twice without harm", () => {
        up(db);
        up(db);

        expect(pathOf("moved")).toBe("2026-11-01/moved.mp4");
    });
});
