import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";
import { up } from "./migrations/20261110_120000_game_room_look_alikes.js";

/**
 * The Game Room giving up look-alikes (§21 "Stages a room does not use"): what it had already
 * found goes, and what the other rooms found -- and the Game Room's identical copies -- stays.
 */

let db: Database.Database;

const root = (id: string, domain: string): void => {
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "domain", "updatedAt")
         VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)`
    ).run(id, `/media/${id}`, id, domain);
};

const item = (id: string, rootId: string, contentHash: string | null = null): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "listRootId", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
    ).run(id, rootId);
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "contentHash", "state", "classification", "lastSeenAt",
                                  "updatedAt")
         VALUES (?, ?, ?, 10, CURRENT_TIMESTAMP, ?, ?, 'active', 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, rootId, `${id}.mp4`, `q-${id}`, contentHash);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);
    db.prepare(
        `INSERT INTO "PhashVideo" ("id", "mediaId", "frameIdx", "atMs", "hash", "band0", "band1",
                                   "band2", "band3", "band4", "band5", "band6", "band7")
         VALUES (?, ?, 0, 0, X'0011223344556677', 0, 0, 0, 0, 0, 0, 0, 0)`
    ).run(`pv-${id}`, id);

    for (const stage of ["phash", "tileprint", "sprite"]) {
        db.prepare(
            `INSERT INTO "MediaStage" ("mediaId", "stage", "version", "state", "attempts")
             VALUES (?, ?, 1, 'done', 1)`
        ).run(id, stage);
    }
};

const group = (id: string, kind: "near" | "exact", members: string[]): void => {
    db.prepare(
        `INSERT INTO "DupeGroup" ("id", "kind", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(id, kind);

    for (const mediaId of members) {
        db.prepare(`INSERT INTO "DupeMember" ("id", "groupId", "mediaId") VALUES (?, ?, ?)`).run(
            `${id}-${mediaId}`,
            id,
            mediaId
        );
    }
};

const apart = (a: string, b: string): void => {
    db.prepare(
        `INSERT INTO "DupeVerdict" ("aId", "bId", "verdict", "decisionId")
         VALUES (?, ?, 'different', 'd1')`
    ).run(a, b);
};

const job = (id: string, kind: string, mediaId: string): void => {
    db.prepare(
        `INSERT INTO "Job" ("id", "kind", "mediaId", "updatedAt")
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, kind, mediaId);
};

const ids = (sql: string): string[] =>
    (db.prepare(sql).all() as { id: string }[]).map((row) => row.id).sort();

beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    root("games", "games");
    root("cellar", "cellar");
    item("g1", "games", "same-bytes");
    item("g2", "games", "same-bytes");
    item("g3", "games");
    item("c1", "cellar");
    item("c2", "cellar");

    group("game-near", "near", ["g1", "g3"]);
    group("game-exact", "exact", ["g1", "g2"]);
    group("cellar-near", "near", ["c1", "c2"]);

    apart("g1", "g3");
    apart("g1", "g2");
    apart("c1", "c2");

    job("j-game", "phash", "g3");
    job("j-game-sprite", "sprite", "g3");
    job("j-cellar", "phash", "c1");
});

describe("game_room_look_alikes", () => {
    it("deletes the Game Room's look-alike groups and keeps its identical ones", () => {
        up(db);

        expect(ids(`SELECT "id" FROM "DupeGroup"`)).toEqual(["cellar-near", "game-exact"]);
        expect(ids(`SELECT "id" FROM "DupeMember" WHERE "groupId" = 'game-near'`)).toEqual([]);
    });

    it("forgets kept-apart verdicts between Game Room items that are not byte-identical", () => {
        up(db);

        expect(
            db.prepare(`SELECT "aId", "bId" FROM "DupeVerdict" ORDER BY "aId", "bId"`).all()
        ).toEqual([
            { aId: "c1", bId: "c2" },
            { aId: "g1", bId: "g2" },
        ]);
    });

    it("drops the Game Room's perceptual hashes and settles its fingerprints as skipped", () => {
        up(db);

        expect(ids(`SELECT DISTINCT "mediaId" AS "id" FROM "PhashVideo"`)).toEqual(["c1", "c2"]);
        expect(
            ids(
                `SELECT "mediaId" || ':' || "stage" AS "id" FROM "MediaStage"
                  WHERE "state" = 'skipped'`
            )
        ).toEqual([
            "g1:phash",
            "g1:tileprint",
            "g2:phash",
            "g2:tileprint",
            "g3:phash",
            "g3:tileprint",
        ]);
        // The filmstrip is the scrubber's, and stays.
        expect(
            db
                .prepare(
                    `SELECT "state" FROM "MediaStage" WHERE "mediaId" = 'g1' AND "stage" = 'sprite'`
                )
                .get()
        ).toEqual({ state: "done" });
    });

    it("drops the Game Room's pending fingerprint jobs and nothing else", () => {
        up(db);

        expect(ids(`SELECT "id" FROM "Job"`)).toEqual(["j-cellar", "j-game-sprite"]);
    });

    it("is idempotent", () => {
        up(db);
        up(db);

        expect(ids(`SELECT "id" FROM "DupeGroup"`)).toEqual(["cellar-near", "game-exact"]);
    });
});
