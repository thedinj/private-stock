import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "./init.js";

/**
 * The denormalised list columns on Media (§20).
 *
 * These exist so one partial index can serve the grid's filter and its ordering together,
 * which is the difference between a page costing 0.4 ms and 6 seconds. The price is that a
 * fact now lives in two places, and the failure mode of a stale copy is unusually nasty: the
 * item vanishes from the grid while its detail page still loads, so the bug reads as "this
 * file isn't in my library" with no other symptom.
 *
 * Triggers maintain them, and this file is what proves the triggers cover every path. The
 * last test is a drift check over a randomised sequence of writes — deliberately not a list
 * of cases I thought of, because the cases I thought of are the ones already handled.
 */

let db: Database.Database;

vi.mock("./db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const { db: sharedDb } = await import("./db.js");

const ROOT_A = "aaaaaaaa-0000-4000-8000-000000000000";
const ROOT_B = "bbbbbbbb-0000-4000-8000-000000000000";

const addRoot = (id: string, rootPath: string): void => {
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`
    ).run(id, rootPath, rootPath);
};

const addMedia = (id: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, 'video', 'Test', CURRENT_TIMESTAMP)`
    ).run(id);
};

const addFile = (
    id: string,
    rootId: string,
    relPath: string,
    size = 100,
    state = "active",
    classification = "media"
): void => {
    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "state", "classification",
              "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, rootId, relPath, size, state, classification);
};

const link = (id: string, mediaId: string, fileId: string, role = "original"): void => {
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role") VALUES (?, ?, ?, ?)`
    ).run(id, mediaId, fileId, role);
};

const listColumns = (
    mediaId: string
): {
    listRootId: string | null;
    listSize: number | null;
    listRelPath: string | null;
    listable: number | null;
} =>
    db
        .prepare(
            `SELECT "listRootId", "listSize", "listRelPath", "listable" FROM "Media" WHERE "id" = ?`
        )
        .get(mediaId) as never;

/**
 * What the columns *should* say, computed the slow way.
 *
 * The point of the drift check is to compare the maintained value against an independent
 * derivation, so this deliberately re-derives from the source tables rather than reusing
 * anything the triggers touch.
 */
const expected = (
    mediaId: string
): {
    listRootId: string | null;
    listSize: number | null;
    listRelPath: string | null;
    listable: number | null;
} => {
    const original = db
        .prepare(
            `SELECT f."rootId", f."size", f."relPath", f."state", f."classification"
               FROM "MediaFileLink" fl
               JOIN "MediaFile" f ON f."id" = fl."fileId"
              WHERE fl."mediaId" = ? AND fl."role" = 'original'
              LIMIT 1`
        )
        .get(mediaId) as
        | { rootId: string; size: number; relPath: string; state: string; classification: string }
        | undefined;

    return {
        listRootId: original?.rootId ?? null,
        listSize: original?.size ?? null,
        listRelPath: original?.relPath ?? null,
        listable:
            original && original.state === "active" && original.classification === "media"
                ? 1
                : null,
    };
};

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    const virtualPrefixes = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "sql" LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

    const tables = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)));

    for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    addRoot(ROOT_A, "videos");
    addRoot(ROOT_B, "archive");
});

describe("maintaining the list columns", () => {
    it("fills them in when a file is linked", () => {
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4", 500);
        link("l1", "m1", "f1");

        expect(listColumns("m1")).toEqual({
            listRootId: ROOT_A,
            listSize: 500,
            listRelPath: "a.mp4",
            listable: 1,
        });
    });

    it("leaves an unlinked item unlistable", () => {
        // A Media row with no active original is real -- it exists between the scan finding
        // a file and the link being written -- and it must not appear in the grid.
        addMedia("m1");

        expect(listColumns("m1")).toEqual({
            listRootId: null,
            listSize: null,
            listRelPath: null,
            listable: null,
        });
    });

    it("drops the item from the grid when its file goes missing", () => {
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4");
        link("l1", "m1", "f1");

        db.prepare(`UPDATE "MediaFile" SET "state" = 'missing' WHERE "id" = ?`).run("f1");

        expect(listColumns("m1").listable).toBeNull();
    });

    it("brings it back when the file returns", () => {
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4", 100, "missing");
        link("l1", "m1", "f1");

        expect(listColumns("m1").listable).toBeNull();

        db.prepare(`UPDATE "MediaFile" SET "state" = 'active' WHERE "id" = ?`).run("f1");

        expect(listColumns("m1").listable).toBe(1);
    });

    it("drops it when the file is reclassified as a companion", () => {
        // A poster beside a video is not a library item, and the classifier can change its
        // mind on a rescan.
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4");
        link("l1", "m1", "f1");

        db.prepare(`UPDATE "MediaFile" SET "classification" = 'companion' WHERE "id" = ?`).run(
            "f1"
        );

        expect(listColumns("m1").listable).toBeNull();
    });

    it("follows a file moved to another root", () => {
        // Access control filters on listRootId, so a stale value here would show an item to
        // someone who was never granted the root it moved into.
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4");
        link("l1", "m1", "f1");

        db.prepare(`UPDATE "MediaFile" SET "rootId" = ? WHERE "id" = ?`).run(ROOT_B, "f1");

        expect(listColumns("m1").listRootId).toBe(ROOT_B);
    });

    it("follows a changed file size", () => {
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4", 100);
        link("l1", "m1", "f1");

        db.prepare(`UPDATE "MediaFile" SET "size" = 999 WHERE "id" = ?`).run("f1");

        expect(listColumns("m1").listSize).toBe(999);
    });

    /**
     * The other half of the contract: a write that changes nothing listed leaves `Media` alone.
     *
     * The trigger fired on every update and rewrote the item row each time, so a file-hash pass
     * rewrote the whole catalogue into the WAL, and every commit of it emptied the web process's
     * page cache (§20).
     */
    it("leaves the item row alone when nothing it lists has changed", () => {
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4", 100);
        link("l1", "m1", "f1");

        db.exec(`
            CREATE TEMP TABLE IF NOT EXISTS "MediaWrites" ("n" INTEGER);
            DELETE FROM temp."MediaWrites";
            CREATE TEMP TRIGGER IF NOT EXISTS "count_media_writes"
            AFTER UPDATE ON main."Media" BEGIN
                INSERT INTO "MediaWrites" VALUES (1);
            END;
        `);
        const writes = (): number =>
            (db.prepare(`SELECT count(*) AS n FROM temp."MediaWrites"`).get() as { n: number }).n;

        db.prepare(
            `UPDATE "MediaFile"
                SET "quickHash" = 'abc', "mtime" = 5, "lastSeenAt" = CURRENT_TIMESTAMP
              WHERE "id" = ?`
        ).run("f1");
        expect(writes()).toBe(0);

        db.prepare(`UPDATE "MediaFile" SET "size" = 200 WHERE "id" = ?`).run("f1");
        expect(writes()).toBe(1);
    });

    it("clears them when the link is removed", () => {
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4");
        link("l1", "m1", "f1");

        db.prepare(`DELETE FROM "MediaFileLink" WHERE "id" = ?`).run("l1");

        expect(listColumns("m1")).toEqual({
            listRootId: null,
            listSize: null,
            listRelPath: null,
            listable: null,
        });
    });

    it("ignores companion links", () => {
        // Only the original decides. A subtitle sidecar must not make an item listable, nor
        // contribute its own size.
        addMedia("m1");
        addFile("f1", ROOT_A, "a.srt", 10);
        link("l1", "m1", "f1", "companion");

        expect(listColumns("m1").listable).toBeNull();
    });

    it("updates through a foreign-key cascade", () => {
        // Deleting a file cascades to its link, and the link's delete trigger is what
        // clears the columns. Whether a cascade fires a trigger is exactly the kind of thing
        // that is easy to assume and wrong.
        addMedia("m1");
        addFile("f1", ROOT_A, "a.mp4");
        link("l1", "m1", "f1");

        db.prepare(`DELETE FROM "MediaFile" WHERE "id" = ?`).run("f1");

        expect(listColumns("m1").listable).toBeNull();
    });
});

describe("drift", () => {
    /**
     * A randomised sequence of the writes the scanner really makes.
     *
     * Deliberately not a list of cases chosen by hand: the hand-chosen ones are the ones
     * already covered above, and drift is by definition what nobody thought of. Every
     * maintained value is compared against an independent re-derivation after every step,
     * so the first divergence is reported rather than the last.
     */
    it("never diverges from a recomputation, over a random write sequence", () => {
        const mediaIds = ["m1", "m2", "m3", "m4"];
        const fileIds = ["f1", "f2", "f3", "f4", "f5"];

        for (const id of mediaIds) addMedia(id);

        let seed = 987_654_321;
        const next = (bound: number): number => {
            seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;

            return (seed >>> 13) % bound;
        };

        for (let step = 0; step < 400; step += 1) {
            const mediaId = mediaIds[next(mediaIds.length)];
            const fileId = fileIds[next(fileIds.length)];

            switch (next(6)) {
                case 0:
                    try {
                        addFile(
                            fileId,
                            next(2) === 0 ? ROOT_A : ROOT_B,
                            `${fileId}-${step}.mp4`,
                            next(1_000)
                        );
                    } catch {
                        // Already present; the scanner hits this constantly.
                    }
                    break;

                case 1:
                    try {
                        link(
                            `l-${mediaId}-${fileId}`,
                            mediaId,
                            fileId,
                            next(4) === 0 ? "companion" : "original"
                        );
                    } catch {
                        // Duplicate link or missing file, both ordinary.
                    }
                    break;

                case 2:
                    db.prepare(`UPDATE "MediaFile" SET "state" = ? WHERE "id" = ?`).run(
                        ["active", "missing", "archived"][next(3)],
                        fileId
                    );
                    break;

                case 3:
                    db.prepare(`UPDATE "MediaFile" SET "classification" = ? WHERE "id" = ?`).run(
                        ["media", "companion", "ignored"][next(3)],
                        fileId
                    );
                    break;

                case 4:
                    db.prepare(
                        `UPDATE "MediaFile" SET "size" = ?, "rootId" = ? WHERE "id" = ?`
                    ).run(next(10_000), next(2) === 0 ? ROOT_A : ROOT_B, fileId);
                    break;

                default:
                    db.prepare(`DELETE FROM "MediaFile" WHERE "id" = ?`).run(fileId);
                    break;
            }

            for (const id of mediaIds) {
                expect({ step, id, ...listColumns(id) }).toEqual({
                    step,
                    id,
                    ...expected(id),
                });
            }
        }
    });
});
