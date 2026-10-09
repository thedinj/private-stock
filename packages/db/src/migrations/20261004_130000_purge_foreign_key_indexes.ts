import type { Database } from "better-sqlite3";

/**
 * Indexes for the foreign keys a purge checks (§10, §20).
 *
 * Deleting a parent row makes SQLite look up every child table that references it, and a child
 * column with no index leading with it is a full scan of that table -- inside the purge's write
 * transaction, which the web process then waits behind. Production logged a single
 * `DELETE FROM "Media"` at 7 s. Measured on a production-sized replica, one purge read ~5,150
 * pages before and ~3,200 after:
 *
 * - `Media.coverArtifactId`: every artifact the item's delete cascades to scanned the whole of
 *   `Media` for a cover pointing at it -- once per artifact. Partial, because almost every item
 *   has no chosen cover; a lookup by value implies `IS NOT NULL`, so the foreign-key check uses it.
 * - `Job.mediaId`: `idx_Job_kind_mediaId` becomes `("mediaId", "kind")`. Every query that used it
 *   pins both columns, so the reversed order serves them all and the check as well, for no new
 *   write. `Job.fileId` needs an index of its own; neither column changes after insert, so claims,
 *   beats and completions never touch either.
 * - `UserMedia.mediaId`: its primary key leads with the user, and the cascade scanned two indexes.
 * - `TrashEntry.mediaId`, `.fileId`, `.twinFileId`: the bin's history is kept, so the table only
 *   grows. Partial on the column being set -- a purge sets them null, so these hold only the
 *   entries still pointing at something.
 *
 * Not here: `MediaTag.mediaId`, which is most of what remains (~3,000 of the ~3,200 pages -- its
 * two uniques lead with it but are partial on `userId`, which a plain lookup does not imply). An
 * index on it lets the planner, which has no statistics, drive the tag browse queries from
 * `Media` by `kind` instead of from the tag, reading every item's row. It belongs beside a change
 * that pins those queries' join order.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_coverArtifactId"
            ON "Media" ("coverArtifactId") WHERE "coverArtifactId" IS NOT NULL;
         CREATE INDEX IF NOT EXISTS "idx_UserMedia_mediaId" ON "UserMedia" ("mediaId");
         DROP INDEX IF EXISTS "idx_Job_kind_mediaId";
         CREATE INDEX IF NOT EXISTS "idx_Job_mediaId_kind" ON "Job" ("mediaId", "kind");
         CREATE INDEX IF NOT EXISTS "idx_Job_fileId" ON "Job" ("fileId");
         CREATE INDEX IF NOT EXISTS "idx_TrashEntry_mediaId"
            ON "TrashEntry" ("mediaId") WHERE "mediaId" IS NOT NULL;
         CREATE INDEX IF NOT EXISTS "idx_TrashEntry_fileId"
            ON "TrashEntry" ("fileId") WHERE "fileId" IS NOT NULL;
         CREATE INDEX IF NOT EXISTS "idx_TrashEntry_twinFileId"
            ON "TrashEntry" ("twinFileId") WHERE "twinFileId" IS NOT NULL;`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP INDEX IF EXISTS "idx_TrashEntry_twinFileId";
         DROP INDEX IF EXISTS "idx_TrashEntry_fileId";
         DROP INDEX IF EXISTS "idx_TrashEntry_mediaId";
         DROP INDEX IF EXISTS "idx_Job_fileId";
         DROP INDEX IF EXISTS "idx_Job_mediaId_kind";
         CREATE INDEX IF NOT EXISTS "idx_Job_kind_mediaId" ON "Job" ("kind", "mediaId");
         DROP INDEX IF EXISTS "idx_UserMedia_mediaId";
         DROP INDEX IF EXISTS "idx_Media_coverArtifactId";`
    );
}
