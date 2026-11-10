import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";
import { up as dupesPerRoom } from "./migrations/20261109_120000_dupe_groups_per_room.js";
import { up as batchDomain } from "./migrations/20261109_120100_tag_batch_domain.js";

/**
 * The two data migrations that put duplicate groups and tag batches each in one room (§21). What
 * has to hold is what each leaves behind on a database that already has rows: no group spanning two
 * rooms, its items owed a clustering pass, and every batch filed in the room its tags are in.
 */

let db: Database.Database;

const addItem = (id: string, rootId: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, 'video', CURRENT_TIMESTAMP)`
    ).run(id);
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash", "state",
                                  "classification", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 10, CURRENT_TIMESTAMP, ?, 'active', 'media', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, rootId, `${id}.mp4`, `q-${id}`);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);
};

const addGroup = (id: string, members: string[]): void => {
    db.prepare(
        `INSERT INTO "DupeGroup" ("id", "kind", "updatedAt") VALUES (?, 'exact', CURRENT_TIMESTAMP)`
    ).run(id);

    for (const mediaId of members) {
        db.prepare(
            `INSERT INTO "DupeMember" ("id", "groupId", "mediaId", "distance") VALUES (?, ?, ?, 0)`
        ).run(`${id}-${mediaId}`, id, mediaId);
        db.prepare(`INSERT INTO "DupeClustered" ("mediaId") VALUES (?)`).run(mediaId);
    }
};

const ids = (sql: string): string[] => (db.prepare(sql).pluck().all() as string[]).sort();

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.exec(`
        INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "domain", "updatedAt") VALUES
            ('cellar', '/media/c', 'Cellar', 1, 'cellar', CURRENT_TIMESTAMP),
            ('games', '/media/g', 'Games', 1, 'games', CURRENT_TIMESTAMP);
        INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
        VALUES ('u1', 'u1@example.test', 'U1', 'x', CURRENT_TIMESTAMP);
    `);
});

describe("duplicate groups per room", () => {
    it("takes apart a group spanning two rooms, and owes its items a pass", () => {
        for (const id of ["a", "b"]) addItem(id, "cellar");
        for (const id of ["c", "d"]) addItem(id, "games");
        addItem("a2", "cellar");
        addItem("c2", "games");
        addGroup("mixed", ["a", "c"]);
        addGroup("cellarOnly", ["b", "a2"]);
        addGroup("gamesOnly", ["d", "c2"]);

        dupesPerRoom(db);

        expect(ids(`SELECT "id" FROM "DupeGroup"`)).toEqual(["cellarOnly", "gamesOnly"]);
        expect(ids(`SELECT "mediaId" FROM "DupeClustered"`)).toEqual(["a2", "b", "c2", "d"]);
        expect(ids(`SELECT "kind" FROM "Job" WHERE "state" = 'pending'`)).toEqual(["dupes"]);
    });

    it("can run again with nothing left to do", () => {
        addItem("a", "cellar");
        addItem("c", "games");
        addGroup("mixed", ["a", "c"]);

        dupesPerRoom(db);
        dupesPerRoom(db);

        expect(ids(`SELECT "id" FROM "DupeGroup"`)).toEqual([]);
    });
});

describe("tag batches per room", () => {
    it("files each batch in the room of the tags it wrote, and leaves one with none unfiled", () => {
        addItem("a", "games");
        db.exec(`
            INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "domain", "updatedAt")
            VALUES ('t1', 'performer', 'Player', 'player', 'games', CURRENT_TIMESTAMP);
            INSERT INTO "TagBatch" ("id", "userId", "summary", "mediaCount") VALUES
                ('b1', 'u1', 'Tagged 1 item', 1),
                ('b2', 'u1', 'Withdrawn', 1);
            INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "createdById", "batchId")
            VALUES ('mt1', 'a', 't1', 'u1', 'b1');
            UPDATE "TagBatch" SET "domain" = NULL;
        `);

        batchDomain(db);

        expect(db.prepare(`SELECT "id", "domain" FROM "TagBatch" ORDER BY "id"`).all()).toEqual([
            { id: "b1", domain: "games" },
            { id: "b2", domain: null },
        ]);
    });
});
