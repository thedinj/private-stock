import type { Database } from "better-sqlite3";

/**
 * Trashing leaves the file where it is (§10): `TrashEntry.trashRelPath` becomes nullable.
 *
 * Trashing used to copy the bytes into `dataDir/trash` and unlink the original, which on the
 * NAS read and wrote every byte on the same four disks and freed nothing until purge. Now a
 * trashed file stays at its path and the purge unlinks it there, so a new entry has no bin
 * path to record. Entries whose bytes did move keep theirs, and drain through the old restore
 * and purge paths within one retention window.
 *
 * An entry whose move never happened has its path cleared too: its bytes are at the original
 * path, which is exactly what an entry made from now on looks like.
 *
 * SQLite cannot drop NOT NULL in place, so the table is rebuilt. The CREATE text is the one in
 * `init.ts`, comments included, because the drift test compares what SQLite stored.
 */
const isNullable = (db: Database): boolean =>
    (
        db
            .prepare(`SELECT "notnull" FROM pragma_table_info('TrashEntry') WHERE "name" = ?`)
            .get("trashRelPath") as { notnull: number } | undefined
    )?.notnull === 0;

const COLUMNS = `"id", "mediaId", "fileId", "rootId", "relPath", "trashRelPath", "bytes",
    "deletedById", "deletedAt", "movedAt", "restoredAt", "purgedAt", "purgeAfter", "twinFileId"`;

const INDEXES = `
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_purgeAfter" ON "TrashEntry" ("purgeAfter")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_pending" ON "TrashEntry" ("deletedAt")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_deletedById" ON "TrashEntry" ("deletedById");
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_open_fileId" ON "TrashEntry" ("fileId")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_mediaId" ON "TrashEntry" ("mediaId")
            WHERE "mediaId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_fileId" ON "TrashEntry" ("fileId")
            WHERE "fileId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_twinFileId" ON "TrashEntry" ("twinFileId")
            WHERE "twinFileId" IS NOT NULL;`;

export function up(db: Database): void {
    if (isNullable(db)) {
        return;
    }

    db.exec(`
        CREATE TABLE "TrashEntry_new" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT,
            -- The physical row this entry trashed. Restore flips its state back and purge
            -- deletes it, and both need to name it directly: "rootId" plus "relPath" looks
            -- like the same thing but is not, because a different file can occupy that path
            -- by the time anyone acts on the entry.
            "fileId" TEXT,
            "rootId" TEXT NOT NULL,
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 1024),
            -- Where the bytes went in dataDir/trash, for an entry made while trashing still
            -- copied files into the bin. Null for every entry since 2026-11-13: the file stays
            -- at its path until the purge unlinks it there (§10).
            "trashRelPath" TEXT CHECK(length("trashRelPath") <= 1024),
            "bytes" INTEGER NOT NULL,
            "deletedById" TEXT NOT NULL,
            "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            -- When those bytes finished moving into dataDir/trash. Set only beside
            -- "trashRelPath": an entry with it is one whose bytes are in the bin, and its
            -- restore and purge act there; an entry without it still has them at its path.
            "movedAt" DATETIME,
            "restoredAt" DATETIME,
            -- Distinct from "restoredAt" on purpose. Closing a purged entry by marking it
            -- restored would be cheaper by one column and would make every destroyed item
            -- read, in the only record that survives it, as one that came back.
            "purgedAt" DATETIME,
            "purgeAfter" DATETIME NOT NULL,
            "twinFileId" TEXT REFERENCES "MediaFile" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("fileId") REFERENCES "MediaFile" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE RESTRICT
        );
        INSERT INTO "TrashEntry_new" (${COLUMNS}) SELECT ${COLUMNS} FROM "TrashEntry";
        UPDATE "TrashEntry_new" SET "trashRelPath" = NULL WHERE "movedAt" IS NULL;
        DROP TABLE "TrashEntry";
        ALTER TABLE "TrashEntry_new" RENAME TO "TrashEntry";
        ${INDEXES}
    `);
}

/**
 * Back to NOT NULL. An in-place entry gets an empty path: the old code would look for its
 * bytes in the bin and find none, which is why this is for development only.
 */
export function down(db: Database): void {
    if (!isNullable(db)) {
        return;
    }

    db.exec(`
        CREATE TABLE "TrashEntry_old" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT,
            -- The physical row this entry trashed. Restore flips its state back and purge
            -- deletes it, and both need to name it directly: "rootId" plus "relPath" looks
            -- like the same thing but is not, because a different file can occupy that path
            -- by the time anyone acts on the entry.
            "fileId" TEXT,
            "rootId" TEXT NOT NULL,
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 1024),
            "trashRelPath" TEXT NOT NULL CHECK(length("trashRelPath") <= 1024),
            "bytes" INTEGER NOT NULL,
            "deletedById" TEXT NOT NULL,
            "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            -- When the bytes finished moving into the bin. Null means the move is still
            -- owed, which is what lets a lost job be found and re-queued: the queue forgets,
            -- and an entry whose file is still sitting in the media root is the one thing
            -- that would never be noticed otherwise.
            "movedAt" DATETIME,
            "restoredAt" DATETIME,
            -- Distinct from "restoredAt" on purpose. Closing a purged entry by marking it
            -- restored would be cheaper by one column and would make every destroyed item
            -- read, in the only record that survives it, as one that came back.
            "purgedAt" DATETIME,
            "purgeAfter" DATETIME NOT NULL,
            "twinFileId" TEXT REFERENCES "MediaFile" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("fileId") REFERENCES "MediaFile" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE RESTRICT
        );
        INSERT INTO "TrashEntry_old" (${COLUMNS})
            SELECT "id", "mediaId", "fileId", "rootId", "relPath", COALESCE("trashRelPath", ''),
                   "bytes", "deletedById", "deletedAt", "movedAt", "restoredAt", "purgedAt",
                   "purgeAfter", "twinFileId"
              FROM "TrashEntry";
        DROP TABLE "TrashEntry";
        ALTER TABLE "TrashEntry_old" RENAME TO "TrashEntry";
        ${INDEXES}
    `);
}
