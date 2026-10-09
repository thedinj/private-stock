import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Reconciliation is the most destructive operation in the scanner: it decides which files
 * have disappeared, and after three consecutive misses those rows are archived and their
 * media leaves the library. These tests exist because getting it wrong is silent.
 */

let db: Database.Database;
let rootId: string;

// The repo module binds to the shared `db` export at import time, so the tests point that
// at an in-memory database rather than the real one.
vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const {
    beginScanSeen,
    countByRoot,
    endScanSeen,
    findById,
    findMoveCandidate,
    identicalMediaIds,
    markMissingAfterScan,
    recordMove,
    upsertSeen,
} = await import("./mediaFileRepo.js");
const { db: sharedDb } = await import("../db.js");

beforeEach(() => {
    db = sharedDb as Database.Database;

    // Enforcement off around the rebuild: "TrashEntry" points at "MediaFile" (§10), and
    // dropping a parent table while foreign keys are enforced fails on the implicit delete.
    db.pragma("foreign_keys = OFF");

    for (const table of ["TrashEntry", "MediaFile", "MediaRoot"]) {
        db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    rootId = "root-1";
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES (?, 'videos', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run(rootId);

    beginScanSeen(SCAN);
});

/** The scan every helper below sees files as. */
const SCAN = "scan-1";

const seeFile = (relPath: string, size = 100, mtime = 1000) =>
    upsertSeen({
        scanId: SCAN,
        rootId,
        relPath,
        size,
        mtime,
        dev: null,
        inode: null,
        classification: "media",
    });

const seeFileWithInode = (relPath: string, inode: string, size = 100, mtime = 1000) =>
    upsertSeen({
        scanId: SCAN,
        rootId,
        relPath,
        size,
        mtime,
        dev: "1",
        inode,
        classification: "media",
    });

const stateOf = (relPath: string) =>
    db
        .prepare(`SELECT "state", "missingScans" FROM "MediaFile" WHERE "relPath" = ?`)
        .get(relPath) as { state: string; missingScans: number };

describe("upsertSeen", () => {
    it("distinguishes new, changed and unchanged files", () => {
        expect(seeFile("a.mp4").outcome).toBe("created");
        expect(seeFile("a.mp4").outcome).toBe("seen");
        expect(seeFile("a.mp4", 200).outcome).toBe("changed");
        expect(seeFile("a.mp4", 200, 2000).outcome).toBe("changed");
    });

    it("clears hashes when the file changed, so stale identity is never reused", () => {
        const created = seeFile("a.mp4");
        db.prepare(
            `UPDATE "MediaFile" SET "quickHash" = 'abc', "contentHash" = 'def' WHERE "id" = ?`
        ).run(created.file.id);

        seeFile("a.mp4", 999);

        const row = db
            .prepare(`SELECT "quickHash", "contentHash" FROM "MediaFile" WHERE "id" = ?`)
            .get(created.file.id) as { quickHash: string | null; contentHash: string | null };

        expect(row.quickHash).toBeNull();
        expect(row.contentHash).toBeNull();
    });

    it("revives a file that came back", () => {
        seeFile("a.mp4");
        db.prepare(`UPDATE "MediaFile" SET "state" = 'missing', "missingScans" = 2`).run();

        seeFile("a.mp4");

        expect(stateOf("a.mp4")).toEqual({ state: "active", missingScans: 0 });
    });
});

/**
 * A rescan that finds nothing new must not write to the database at all.
 *
 * It used to rewrite every row it saw, and the list trigger rewrote each item's `Media` row
 * after it — the whole catalogue through the WAL on every scan, emptying the web process's page
 * cache with every commit (§20). Confirmations go to a temp table instead, which is outside the
 * main file, so these tests pin down both halves: nothing written, and nothing forgotten.
 */
describe("an unchanged rescan", () => {
    const countFileWrites = (): (() => number) => {
        db.exec(`
            CREATE TEMP TABLE IF NOT EXISTS "FileWrites" ("n" INTEGER);
            DELETE FROM temp."FileWrites";
            CREATE TEMP TRIGGER IF NOT EXISTS "count_file_writes"
            AFTER UPDATE ON main."MediaFile" BEGIN
                INSERT INTO "FileWrites" VALUES (1);
            END;
        `);

        return () =>
            (db.prepare(`SELECT count(*) AS n FROM temp."FileWrites"`).get() as { n: number }).n;
    };

    it("writes nothing for a file it finds as it was", () => {
        seeFile("a.mp4");
        const writes = countFileWrites();

        expect(seeFile("a.mp4").outcome).toBe("seen");
        expect(writes()).toBe(0);
    });

    it("still writes a file whose row has something new to say", () => {
        seeFile("a.mp4");
        const writes = countFileWrites();

        expect(seeFile("a.mp4", 200).outcome).toBe("changed");
        expect(writes()).toBe(1);
    });

    it("counts a file it did not write as seen when reconciling", () => {
        seeFile("a.mp4");
        seeFile("a.mp4");

        // A start time after every write, so only the confirmation can save the row.
        expect(markMissingAfterScan(rootId, SCAN, "2999-01-01 00:00:00")).toBe(0);
        expect(stateOf("a.mp4").state).toBe("active");
    });

    it("does not accept another scan's confirmations", () => {
        seeFile("a.mp4");
        seeFile("a.mp4");
        beginScanSeen("scan-2");

        expect(markMissingAfterScan(rootId, "scan-2", "2999-01-01 00:00:00")).toBe(1);
    });

    it("forgets a scan's confirmations when it ends", () => {
        seeFile("a.mp4");
        seeFile("a.mp4");
        endScanSeen(SCAN);

        expect(markMissingAfterScan(rootId, SCAN, "2999-01-01 00:00:00")).toBe(1);
    });
});

describe("markMissingAfterScan", () => {
    /**
     * The regression this file exists for.
     *
     * SQLite writes "2026-09-15 00:30:14"; `Date.toISOString()` produces
     * "2026-09-15T00:30:14.532Z". Compared as text the space sorts before the "T", so every
     * row appears older than the scan start and the whole library is marked missing. Passing
     * the database's own value is what keeps the comparison meaningful.
     */
    it("does not mark files missing when given the database's own start timestamp", () => {
        const startedAt = db.prepare(`SELECT CURRENT_TIMESTAMP AS t`).get() as { t: string };

        seeFile("a.mp4");
        seeFile("b.mp4");

        expect(markMissingAfterScan(rootId, SCAN, startedAt.t)).toBe(0);
        expect(stateOf("a.mp4").state).toBe("active");
    });

    it("would mark everything missing if given a JavaScript ISO string", () => {
        seeFile("a.mp4");

        // Documents the trap rather than endorsing it: the formats are not comparable, and
        // this is what the bug looked like.
        const isoNow = new Date().toISOString();

        expect(markMissingAfterScan(rootId, SCAN, isoNow)).toBe(1);
    });

    it("marks a file missing once it stops being seen, and archives it after three scans", () => {
        seeFile("gone.mp4");

        const future = "2999-01-01 00:00:00";

        expect(markMissingAfterScan(rootId, SCAN, future)).toBe(1);
        expect(stateOf("gone.mp4")).toEqual({ state: "missing", missingScans: 1 });

        markMissingAfterScan(rootId, SCAN, future);
        expect(stateOf("gone.mp4")).toEqual({ state: "missing", missingScans: 2 });

        markMissingAfterScan(rootId, SCAN, future);
        expect(stateOf("gone.mp4")).toEqual({ state: "archived", missingScans: 3 });

        // Archived is terminal: further scans must not keep incrementing forever.
        expect(markMissingAfterScan(rootId, SCAN, future)).toBe(0);
    });

    /**
     * The subtree trap.
     *
     * A watcher-triggered scan walks one directory. Reconciling that against the whole root
     * would mark every file outside it missing — the library would empty itself every time
     * someone dropped a file into a folder.
     */
    it("confines a subtree scan to its own subtree", () => {
        seeFile("holiday/a.mp4");
        seeFile("archive/b.mp4");

        const future = "2999-01-01 00:00:00";

        expect(markMissingAfterScan(rootId, SCAN, future, "holiday")).toBe(1);
        expect(stateOf("holiday/a.mp4").state).toBe("missing");
        expect(stateOf("archive/b.mp4").state).toBe("active");
    });

    it("does not let a subtree name act as a wildcard", () => {
        seeFile("holiday/a.mp4");
        seeFile("holiday-2024/b.mp4");

        // "holiday" must not match "holiday-2024"; the prefix is a path segment, not a
        // string prefix.
        markMissingAfterScan(rootId, SCAN, "2999-01-01 00:00:00", "holiday");

        expect(stateOf("holiday/a.mp4").state).toBe("missing");
        expect(stateOf("holiday-2024/b.mp4").state).toBe("active");
    });

    it("escapes LIKE metacharacters in a directory name", () => {
        seeFile("100%_best/a.mp4");
        seeFile("100x_best/b.mp4");

        markMissingAfterScan(rootId, SCAN, "2999-01-01 00:00:00", "100%_best");

        expect(stateOf("100%_best/a.mp4").state).toBe("missing");
        // Without escaping, "%" and "_" would make this match too.
        expect(stateOf("100x_best/b.mp4").state).toBe("active");
    });
});

describe("detecting a move", () => {
    /**
     * Renaming a directory used to look like deleting every file in it.
     *
     * The old items were archived, taking their tags, ratings and history out of view, and
     * the files came back as blank new ones. Reorganising folders is a normal thing to do, so
     * this is the difference between a cataloguer and a file lister.
     */
    it("recognises the same file at a new path", () => {
        const original = seeFileWithInode("old/clip.mp4", "42");

        const candidate = findMoveCandidate({
            rootId,
            dev: "1",
            inode: "42",
            size: 100,
            mtime: 1000,
            scanStartedAt: "2999-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate?.id).toBe(original.file.id);
    });

    it("keeps the same row, so everything attached to it follows", () => {
        const original = seeFileWithInode("old/clip.mp4", "42");

        recordMove(original.file.id, "new/clip.mp4");

        const after = findById(original.file.id);

        expect(after?.relPath).toBe("new/clip.mp4");
        expect(after?.state).toBe("active");
        // One row, not two: the old path does not linger as a second file.
        expect(countByRoot(rootId)).toBe(1);
    });

    /**
     * Inode numbers are reused once a file is deleted.
     *
     * An unrelated new file that inherited one would otherwise be treated as the old file
     * moved, silently attaching one file's history to another.
     */
    it("refuses a match whose size disagrees", () => {
        seeFileWithInode("old/clip.mp4", "42", 100);

        const candidate = findMoveCandidate({
            rootId,
            dev: "1",
            inode: "42",
            size: 999,
            mtime: 1000,
            scanStartedAt: "2999-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate).toBeUndefined();
    });

    /**
     * Two matches mean the evidence does not identify one file.
     *
     * Guessing would attach one file's history to another, which is worse than missing the
     * move -- that only costs what the old behaviour cost anyway.
     */
    it("refuses to guess between two candidates", () => {
        upsertSeen({
            scanId: SCAN,
            rootId,
            relPath: "a.mp4",
            size: 100,
            mtime: 1000,
            dev: null,
            inode: null,
            classification: "media",
        });
        upsertSeen({
            scanId: SCAN,
            rootId,
            relPath: "b.mp4",
            size: 100,
            mtime: 1000,
            dev: null,
            inode: null,
            classification: "media",
        });

        const candidate = findMoveCandidate({
            rootId,
            dev: null,
            inode: null,
            size: 100,
            mtime: 1000,
            scanStartedAt: "2999-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate).toBeUndefined();
    });

    /** A file this scan has already seen is where it belongs and cannot be the source. */
    it("ignores files the current scan has already seen", () => {
        seeFileWithInode("old/clip.mp4", "42");

        const candidate = findMoveCandidate({
            rootId,
            dev: "1",
            inode: "42",
            size: 100,
            mtime: 1000,
            scanStartedAt: "1970-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate).toBeUndefined();
    });

    /**
     * The same rule for a file confirmed rather than written. A hard link is the case: a new
     * path sharing an inode with one this scan has already placed must not make that placed
     * row a second candidate, or the real move beside it is refused as ambiguous.
     */
    it("ignores files the current scan confirmed without writing", () => {
        seeFileWithInode("old/clip.mp4", "42");
        seeFileWithInode("old/clip.mp4", "42");

        const candidate = findMoveCandidate({
            rootId,
            dev: "1",
            inode: "42",
            size: 100,
            mtime: 1000,
            scanStartedAt: "2999-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate).toBeUndefined();
    });

    it("does not match across libraries", () => {
        seeFileWithInode("old/clip.mp4", "42");

        const candidate = findMoveCandidate({
            rootId: "another-root",
            dev: "1",
            inode: "42",
            size: 100,
            mtime: 1000,
            scanStartedAt: "2999-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate).toBeUndefined();
    });

    /** Without a usable inode the weaker signal is all there is, and it still has to be unique. */
    it("falls back to size and mtime when the filesystem gives no inode", () => {
        const original = seeFile("old/clip.mp4", 100, 1000);

        const candidate = findMoveCandidate({
            rootId,
            dev: null,
            inode: null,
            size: 100,
            mtime: 1000,
            scanStartedAt: "2999-01-01 00:00:00",
            scanId: SCAN,
        });

        expect(candidate?.id).toBe(original.file.id);
    });
});

/**
 * Which items an identical copy may borrow artifacts from (§10f).
 *
 * Getting this wrong in the generous direction gives an item another file's pictures, so every
 * case here is one that must *not* match: a different hash, no hash, and a twin that has left.
 */
describe("identicalMediaIds", () => {
    const fileWith = (relPath: string, contentHash: string | null, mediaId: string): string => {
        const { file } = seeFile(relPath);

        db.prepare(`UPDATE "MediaFile" SET "contentHash" = ? WHERE "id" = ?`).run(
            contentHash,
            file.id
        );
        db.prepare(
            `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, 'video', 'now')`
        ).run(mediaId);
        db.prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES (?, ?, ?, 'original')`
        ).run(`link-${mediaId}`, mediaId, file.id);

        return file.id;
    };

    beforeEach(() => {
        db.exec(`DELETE FROM "MediaFileLink"; DELETE FROM "Media";`);
    });

    it("finds the items holding the same bytes, and only those", () => {
        const a = fileWith("a.mp4", "same", "m-a");
        fileWith("b.mp4", "same", "m-b");
        fileWith("c.mp4", "other", "m-c");

        expect(identicalMediaIds(a)).toEqual(["m-b"]);
    });

    it("never matches on a missing hash", () => {
        const a = fileWith("a.mp4", null, "m-a");
        fileWith("b.mp4", null, "m-b");

        expect(identicalMediaIds(a)).toEqual([]);
    });

    it("ignores a twin that is no longer in the library", () => {
        const a = fileWith("a.mp4", "same", "m-a");
        const b = fileWith("b.mp4", "same", "m-b");

        db.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = ?`).run(b);

        expect(identicalMediaIds(a)).toEqual([]);
    });
});
