import type { Database } from "better-sqlite3";

/**
 * Delete an identical copy outright instead of trashing it (§10e).
 *
 * When the file being deleted is byte-for-byte the same as another file that stays -- equal
 * `contentHash` -- the bin has nothing to offer: the content is still in the library. So it
 * bypasses the bin. `twinFileId` names the file that stays; the trash job checks it still holds
 * the bytes, deletes the original and purges the item in one go, and the entry is left only as
 * the audit row. Such an entry is never listed, counted or restorable.
 *
 * Nullable, no default: every existing entry is an ordinary one, which is what null means.
 * ON DELETE SET NULL, like "fileId", so the audit row outlives the file it names.
 */
const hasColumn = (db: Database): boolean =>
    db
        .prepare(`SELECT 1 FROM pragma_table_info('TrashEntry') WHERE "name" = 'twinFileId'`)
        .get() !== undefined;

/**
 * Idempotent: a database built by `init.ts` already has the column and is then stamped by
 * replaying the history, and SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "TrashEntry" ADD COLUMN "twinFileId" TEXT
                 REFERENCES "MediaFile" ("id") ON DELETE SET NULL;`
        );
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "TrashEntry" DROP COLUMN "twinFileId";`);
    }
}
