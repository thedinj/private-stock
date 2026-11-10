import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * A duplicate group is of one room (§21).
 *
 * The same file in the Cellar and the Game Room is two rooms' business: grouped together, one
 * room's Review queue shows the other's titles and covers, and deleting one copy hands its tags and
 * playlist places to the other. So clustering joins only items of the same room -- and a group
 * written before it did comes apart into one per room the next time anything touches it.
 *
 * Against a real database rather than a mock, because what matters is which groups end up in
 * `DupeGroup`; the shared connection is pointed at one in memory before the job is loaded.
 */

const memory = new Database(":memory:");
memory.pragma("foreign_keys = ON");
(globalThis as unknown as { privateStockDb: Database.Database }).privateStockDb = memory;

const { initializeDatabase } = await import("@private-stock/db");
const { runDupes } = await import("./dupes.js");

const db = memory;

beforeEach(() => {
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "DupeMember"; DELETE FROM "DupeGroup"; DELETE FROM "DupeClustered";
        DELETE FROM "Job"; DELETE FROM "Setting";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot";
    `);
    db.exec(`
        INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "domain", "updatedAt") VALUES
            ('cellar', '/media/c', 'Cellar', 1, 'cellar', CURRENT_TIMESTAMP),
            ('games', '/media/g', 'Games', 1, 'games', CURRENT_TIMESTAMP);
    `);
});

/** An item whose original has these bytes, in this library. */
const givenCopy = (id: string, rootId: string, contentHash: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, 'video', CURRENT_TIMESTAMP)`
    ).run(id);
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "contentHash", "state", "classification", "lastSeenAt",
                                  "updatedAt")
         VALUES (?, ?, ?, 10, CURRENT_TIMESTAMP, ?, ?, 'active', 'media', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, rootId, `${id}.mp4`, `q-${id}`, contentHash);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);
};

/** Each group's members, sorted, groups sorted: what the queue would show. */
const groups = (): string[][] => {
    const byGroup = new Map<string, string[]>();

    for (const row of db.prepare(`SELECT "groupId", "mediaId" FROM "DupeMember"`).all() as {
        groupId: string;
        mediaId: string;
    }[]) {
        byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row.mediaId]);
    }

    return [...byGroup.values()].map((members) => members.sort()).sort();
};

const run = (): Promise<void> => runDupes({} as Parameters<typeof runDupes>[0]);

describe("clustering by room", () => {
    it("groups identical files within a room and never across two", async () => {
        givenCopy("c1", "cellar", "same");
        givenCopy("c2", "cellar", "same");
        givenCopy("g1", "games", "same");
        givenCopy("g2", "games", "same");

        await run();

        expect(groups()).toEqual([
            ["c1", "c2"],
            ["g1", "g2"],
        ]);
    });

    it("makes no group of one copy in each room", async () => {
        givenCopy("c1", "cellar", "same");
        givenCopy("g1", "games", "same");

        await run();

        expect(groups()).toEqual([]);
    });

    it("takes apart a group spanning two rooms when its items are compared again", async () => {
        givenCopy("c1", "cellar", "same");
        givenCopy("c2", "cellar", "same");
        givenCopy("g1", "games", "same");
        givenCopy("g2", "games", "same");

        // Written before rooms: all four in one group.
        db.prepare(
            `INSERT INTO "DupeGroup" ("id", "kind", "updatedAt")
             VALUES ('old', 'exact', CURRENT_TIMESTAMP)`
        ).run();
        for (const id of ["c1", "c2", "g1", "g2"]) {
            db.prepare(
                `INSERT INTO "DupeMember" ("id", "groupId", "mediaId", "distance")
                 VALUES (?, 'old', ?, 0)`
            ).run(`m-${id}`, id);
        }

        await run();

        expect(groups()).toEqual([
            ["c1", "c2"],
            ["g1", "g2"],
        ]);
    });
});
