import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The change feed is what makes the grid update itself (§13b).
 *
 * The properties worth pinning are about the cursor. A browser reconnects by sending the last
 * id it saw, so ids must be totally ordered and must never be handed out twice — including
 * after the feed has been pruned, which is the case that would silently skip changes.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const changeLogRepo = await import("./changeLogRepo.js");
const { db: sharedDb } = await import("../db.js");

beforeEach(() => {
    db = sharedDb as Database.Database;

    db.pragma("foreign_keys = OFF");

    const tables = db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[];

    for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
});

describe("record and readSince", () => {
    it("returns changes after a cursor, in order", () => {
        changeLogRepo.record({ entity: "media", entityId: "a", op: "insert" });
        changeLogRepo.record({ entity: "media", entityId: "b", op: "insert" });
        changeLogRepo.record({ entity: "artifact", entityId: "a", op: "update" });

        const all = changeLogRepo.readSince(0);
        expect(all.map((row) => row.entityId)).toEqual(["a", "b", "a"]);
        expect(all.map((row) => row.id)).toEqual(
            [...all.map((row) => row.id)].sort((x, y) => x - y)
        );

        // Resuming from the middle yields only what came after it.
        expect(changeLogRepo.readSince(all[0].id).map((row) => row.entityId)).toEqual(["b", "a"]);
        expect(changeLogRepo.readSince(all[2].id)).toEqual([]);
    });

    it("carries the root id, so the feed can be filtered per connection", () => {
        changeLogRepo.record({ entity: "media", entityId: "a", rootId: "root-1", op: "insert" });

        expect(changeLogRepo.readSince(0)[0].rootId).toBe("root-1");
    });

    it("honours the limit, which is how a caller detects it has fallen behind", () => {
        for (let i = 0; i < 10; i += 1) {
            changeLogRepo.record({ entity: "media", entityId: String(i), op: "insert" });
        }

        expect(changeLogRepo.readSince(0, 4)).toHaveLength(4);
    });

    it("truncates an over-long detail rather than failing the write", () => {
        // The row is written inside the transaction of the change it describes. A CHECK
        // constraint failing here would roll back the change itself, which is far worse than
        // a clipped hint.
        changeLogRepo.record({
            entity: "media",
            entityId: "a",
            op: "update",
            detail: "x".repeat(900),
        });

        expect(changeLogRepo.readSince(0)[0].detail).toHaveLength(500);
    });
});

describe("recordMany", () => {
    it("writes a batch in order and tolerates an empty one", () => {
        changeLogRepo.recordMany([]);
        expect(changeLogRepo.readSince(0)).toEqual([]);

        changeLogRepo.recordMany([
            { entity: "media", entityId: "a", op: "insert" },
            { entity: "media", entityId: "b", op: "insert" },
        ]);

        expect(changeLogRepo.readSince(0).map((row) => row.entityId)).toEqual(["a", "b"]);
    });
});

describe("latestId", () => {
    it("is 0 on an empty feed, so a fresh client starts from now rather than replaying", () => {
        expect(changeLogRepo.latestId()).toBe(0);

        changeLogRepo.record({ entity: "media", entityId: "a", op: "insert" });

        expect(changeLogRepo.latestId()).toBe(changeLogRepo.readSince(0)[0].id);
    });
});

describe("prune", () => {
    it("removes only rows older than the window", () => {
        changeLogRepo.record({ entity: "media", entityId: "old", op: "insert" });
        db.prepare(`UPDATE "ChangeLog" SET "at" = datetime(CURRENT_TIMESTAMP, '-2 hours')`).run();

        changeLogRepo.record({ entity: "media", entityId: "new", op: "insert" });

        expect(changeLogRepo.prune(60)).toBe(1);
        expect(changeLogRepo.readSince(0).map((row) => row.entityId)).toEqual(["new"]);
    });

    it("never reissues an id after pruning", () => {
        changeLogRepo.record({ entity: "media", entityId: "first", op: "insert" });
        const firstId = changeLogRepo.readSince(0)[0].id;

        db.prepare(`UPDATE "ChangeLog" SET "at" = datetime(CURRENT_TIMESTAMP, '-2 hours')`).run();
        changeLogRepo.prune(60);

        changeLogRepo.record({ entity: "media", entityId: "second", op: "insert" });

        // This is what AUTOINCREMENT buys. Without it SQLite reuses the ids of deleted rows,
        // and a browser reconnecting with `Last-Event-ID: <firstId>` would be told there is
        // nothing new — having missed everything written since.
        expect(changeLogRepo.readSince(0)[0].id).toBeGreaterThan(firstId);
        expect(changeLogRepo.readSince(firstId).map((row) => row.entityId)).toEqual(["second"]);
    });
});
