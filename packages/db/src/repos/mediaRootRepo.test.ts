import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Libraries (§12b).
 *
 * The claim worth testing is the one the whole design rests on: **moving content is a
 * repoint**. If the catalogue did not survive changing a library's path, the path would be an
 * identity in everything but name and an admin's only option after moving a drive would be to
 * re-import and lose every tag and rating.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaRootRepo = await import("./mediaRootRepo.js");
const { db: sharedDb } = await import("../db.js");

const USER = "bbbbbbbb-0000-4000-8000-000000000000";

/** An item catalogued in a library, with a tag and a rating hanging off it. */
const addCataloguedItem = (rootId: string, mediaId: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, 'video', 'Test', CURRENT_TIMESTAMP)`
    ).run(mediaId);

    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 1024, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${mediaId}`, rootId, `season one/${mediaId}.mp4`);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${mediaId}`, mediaId, `f-${mediaId}`);

    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
         VALUES (?, 'performer', ?, ?, CURRENT_TIMESTAMP)`
    ).run(`t-${mediaId}`, `Someone ${mediaId}`, `someone ${mediaId}`);

    db.prepare(
        `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source")
         VALUES (?, ?, ?, 'user')`
    ).run(`mt-${mediaId}`, mediaId, `t-${mediaId}`);

    db.prepare(
        `INSERT INTO "UserMedia" ("userId", "mediaId", "rating", "updatedAt")
         VALUES (?, ?, 4, CURRENT_TIMESTAMP)`
    ).run(USER, mediaId);

    db.prepare(
        `INSERT INTO "Artifact" ("id", "mediaId", "kind", "relPath")
         VALUES (?, ?, 'cover', ?)`
    ).run(`a-${mediaId}`, mediaId, `ab/${mediaId}.jpg`);

    db.prepare(
        `INSERT INTO "MediaStage" ("mediaId", "stage", "state", "at")
         VALUES (?, 'cover', 'done', CURRENT_TIMESTAMP)`
    ).run(mediaId);

    db.prepare(`INSERT INTO "MediaSearchDoc" ("mediaId", "title") VALUES (?, 'Test')`).run(mediaId);
};

/** Everything that hangs off an item, counted in one go. */
const remaining = () =>
    Object.fromEntries(
        [
            "Media",
            "MediaFile",
            "MediaFileLink",
            "MediaTag",
            "UserMedia",
            "Artifact",
            "MediaStage",
            "MediaSearchDoc",
        ].map((table) => [
            table,
            (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n,
        ])
    );

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

    for (const table of (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)))) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
         VALUES (?, 'a@b.c', 'Curator', 'x', 'admin', CURRENT_TIMESTAMP)`
    ).run(USER);
});

describe("adding a library", () => {
    it("starts disabled, so nothing indexes a share nobody asked for", () => {
        const root = mediaRootRepo.create("/media/videos", "Videos");

        expect(root.enabled).toBeNull();
        expect(root.writable).toBeNull();
    });

    it("keys on the path, so two drives can each hold a Videos folder", () => {
        mediaRootRepo.create("/mnt/a/Videos", "Drive A");
        mediaRootRepo.create("/mnt/b/Videos", "Drive B");

        expect(mediaRootRepo.listRoots()).toHaveLength(2);
    });

    it("refuses the same directory twice", () => {
        mediaRootRepo.create("/media/videos", "Videos");

        expect(() => mediaRootRepo.create("/media/videos", "Again")).toThrow();
    });
});

describe("moving a library", () => {
    /**
     * The point of the whole design.
     *
     * File paths are stored relative to their library, so pointing it at a new directory is
     * the entire migration. Anything else would mean an admin who moved a drive had to choose
     * between a broken library and losing every tag and rating in it.
     */
    it("keeps the catalogue, the tags and the ratings", () => {
        const root = mediaRootRepo.create("/mnt/old/Videos", "Videos");
        addCataloguedItem(root.id, "m1");

        mediaRootRepo.setPath(root.id, "/mnt/new/Videos");

        expect(mediaRootRepo.findById(root.id)?.path).toBe("/mnt/new/Videos");
        expect(db.prepare(`SELECT count(*) AS n FROM "Media"`).get()).toEqual({ n: 1 });
        expect(db.prepare(`SELECT count(*) AS n FROM "MediaTag"`).get()).toEqual({ n: 1 });
        expect(
            (
                db.prepare(`SELECT "rating" FROM "UserMedia" WHERE "mediaId" = 'm1'`).get() as {
                    rating: number;
                }
            ).rating
        ).toBe(4);
    });

    it("leaves the stored file paths relative, so they still resolve under the new directory", () => {
        const root = mediaRootRepo.create("/mnt/old/Videos", "Videos");
        addCataloguedItem(root.id, "m1");

        mediaRootRepo.setPath(root.id, "/mnt/new/Videos");

        const file = db.prepare(`SELECT "relPath" FROM "MediaFile" WHERE "id" = 'f-m1'`).get() as {
            relPath: string;
        };

        // Untouched, and that is what makes the move free: the absolute path is composed at
        // read time from the library's path plus this.
        expect(file.relPath).toBe("season one/m1.mp4");
    });

    /**
     * Hiding is the honest position after a repoint.
     *
     * The path changed; nobody has looked. An item shown from a directory nobody has checked
     * can be played, transcoded or deleted against whatever happens to occupy that relative
     * path, and none of those failures announce themselves.
     */
    it("hides every item until a scan confirms it", () => {
        const root = mediaRootRepo.create("/mnt/old/Videos", "Videos");
        addCataloguedItem(root.id, "m1");

        mediaRootRepo.setPath(root.id, "/mnt/new/Videos");
        mediaRootRepo.markUnverified(root.id);

        const file = db.prepare(`SELECT "state" FROM "MediaFile" WHERE "id" = 'f-m1'`).get() as {
            state: string;
        };
        const media = db.prepare(`SELECT "listable" FROM "Media" WHERE "id" = 'm1'`).get() as {
            listable: number | null;
        };

        expect(file.state).toBe("unverified");
        // Hidden, not lost: the row and everything on it is still there.
        expect(media.listable).toBeNull();
        expect(remaining().Media).toBe(1);
        expect(remaining().MediaTag).toBe(1);
    });

    /**
     * A trashed file is not in the library and its state is a decision, not an observation.
     *
     * Marking it unverified would put it back in the library's population, and the next scan
     * would then reconcile a file that is deliberately sitting in /data/trash.
     */
    it("leaves trashed files alone", () => {
        const root = mediaRootRepo.create("/mnt/old/Videos", "Videos");
        addCataloguedItem(root.id, "m1");
        db.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-m1'`).run();

        mediaRootRepo.markUnverified(root.id);

        const file = db.prepare(`SELECT "state" FROM "MediaFile" WHERE "id" = 'f-m1'`).get() as {
            state: string;
        };

        expect(file.state).toBe("trashed");
    });

    it("counts what is waiting, so the admin page can say so", () => {
        const root = mediaRootRepo.create("/mnt/old/Videos", "Videos");
        addCataloguedItem(root.id, "m1");
        addCataloguedItem(root.id, "m2");

        expect(mediaRootRepo.markUnverified(root.id)).toBe(2);
    });

    it("keeps each library's own settings across a move", () => {
        const root = mediaRootRepo.create("/mnt/old/Videos", "Videos");
        mediaRootRepo.setEnabled(root.id, true);
        mediaRootRepo.setWritable(root.id, true);
        mediaRootRepo.setLabel(root.id, "Films");

        mediaRootRepo.setPath(root.id, "/mnt/new/Videos");

        const after = mediaRootRepo.findById(root.id)!;

        expect(after.label).toBe("Films");
        expect(after.enabled).toBe(1);
        expect(after.writable).toBe(1);
    });
});

describe("forgetting a library", () => {
    /**
     * The only way a library row disappears.
     *
     * Nothing removes one for being unreachable — an offline share would otherwise cost an
     * admin everything they had recorded about it, which is the failure this whole model was
     * chosen to avoid.
     */
    /**
     * The bug this test exists for.
     *
     * Deleting the library cascades to `MediaFile` and its links and stops, because `Media`
     * hangs off the file rather than the library. Every item used to survive as an orphan,
     * invisible because the `listable` trigger had just cleared it, carrying its tags,
     * ratings, artifacts, processing history and search document with it forever.
     */
    it("leaves nothing behind", () => {
        const root = mediaRootRepo.create("/media/videos", "Videos");
        addCataloguedItem(root.id, "m1");

        mediaRootRepo.remove(root.id);

        expect(mediaRootRepo.listRoots()).toEqual([]);
        expect(remaining()).toEqual({
            Media: 0,
            MediaFile: 0,
            MediaFileLink: 0,
            MediaTag: 0,
            UserMedia: 0,
            Artifact: 0,
            MediaStage: 0,
            MediaSearchDoc: 0,
        });
    });

    it("leaves other libraries alone", () => {
        const kept = mediaRootRepo.create("/media/photos", "Photos");
        const gone = mediaRootRepo.create("/media/videos", "Videos");
        addCataloguedItem(kept.id, "m1");
        addCataloguedItem(gone.id, "m2");

        mediaRootRepo.remove(gone.id);

        expect(mediaRootRepo.listRoots().map((root) => root.id)).toEqual([kept.id]);
        expect(remaining()).toEqual({
            Media: 1,
            MediaFile: 1,
            MediaFileLink: 1,
            MediaTag: 1,
            UserMedia: 1,
            Artifact: 1,
            MediaStage: 1,
            MediaSearchDoc: 1,
        });
    });

    /**
     * An item catalogued from two libraries survives losing one of them.
     *
     * The deletion asks whether an *original* link remains rather than removing every item
     * that lost a file, so this is a property of the rule rather than a lucky accident.
     */
    it("keeps an item that still has an original elsewhere", () => {
        const first = mediaRootRepo.create("/media/a", "A");
        const second = mediaRootRepo.create("/media/b", "B");
        addCataloguedItem(first.id, "m1");

        // The same item, also present in the second library.
        db.prepare(
            `INSERT INTO "MediaFile"
                 ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
             VALUES ('f-copy', ?, 'copy.mp4', 1024, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).run(second.id);
        db.prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES ('l-copy', 'm1', 'f-copy', 'companion')`
        ).run();

        mediaRootRepo.remove(second.id);

        expect(remaining().Media).toBe(1);
        expect(remaining().MediaTag).toBe(1);
    });
});
