import type { Database } from "better-sqlite3";

/**
 * A file's open trash entry, by index (§10g).
 *
 * The unreadable-files list joins each row to its open entry, and `findOpenForFile` has always
 * looked one up the same way -- both read every entry ever made, because purged entries are kept
 * as history. Partial on the entry being open, like the table's other two indexes.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_TrashEntry_open_fileId" ON "TrashEntry" ("fileId")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_TrashEntry_open_fileId";`);
}
