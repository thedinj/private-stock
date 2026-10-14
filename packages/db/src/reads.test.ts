import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "./init.js";

/**
 * Read plans and their drivers (§20 "Reads off the thread").
 *
 * The thread itself is exercised by `docker/smoke.sh`, which loads it from compiled output the
 * way the container does; under vitest there is no `.js` entry to start, and `runOffThread`
 * runs inline. What is tested here is that a plan means the same thing under either driver:
 * the same rows, the same errors, handed back into the plan at the same point.
 */

vi.mock("./db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const { read, runNow } = await import("./reads.js");
const { runOffThread } = await import("./readPool.js");
const { db: sharedDb } = await import("./db.js");
const db = sharedDb as unknown as Database.Database;

const USER = "u-ada";

beforeEach(() => {
    initializeDatabase(db);
    db.exec(`DELETE FROM "MediaTag"; DELETE FROM "Tag"; DELETE FROM "Media";`);
});

const addTagged = (id: string, tag: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "updatedAt")
         VALUES (?, 'video', ?, 1, CURRENT_TIMESTAMP)`
    ).run(id, id);
    db.prepare(
        `INSERT OR IGNORE INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
         VALUES (?, 'tag', ?, ?, CURRENT_TIMESTAMP)`
    ).run(tag, tag, tag);
    db.prepare(
        `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES (?, ?, ?, 'user')`
    ).run(`${id}-${tag}`, id, tag);
};

function* namesOf(ids: string[]) {
    const rows = yield* read("tagsForMediaIds", ids, USER);

    return rows.map((row) => `${row.mediaId}:${row.name}`);
}

describe("read plans", () => {
    it("hand each statement's rows back to the plan", () => {
        addTagged("m1", "noir");
        addTagged("m2", "drama");

        expect(runNow(namesOf(["m1", "m2"]))).toEqual(["m2:drama", "m1:noir"]);
    });

    it("mean the same under either driver", async () => {
        addTagged("m1", "noir");

        await expect(runOffThread(namesOf(["m1"]))).resolves.toEqual(runNow(namesOf(["m1"])));
    });

    it("hand a failed statement back into the plan, where it can be caught", async () => {
        function* recovering() {
            try {
                // No arguments at all: the repo function throws on its first line.
                yield { name: "tagsForMediaIds" as const, args: [] };

                return "no error";
            } catch {
                return "caught";
            }
        }

        expect(runNow(recovering())).toBe("caught");
        await expect(runOffThread(recovering())).resolves.toBe("caught");
    });
});
