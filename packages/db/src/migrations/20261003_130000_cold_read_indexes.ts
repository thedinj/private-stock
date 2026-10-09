import type { Database } from "better-sqlite3";

/**
 * Indexes for the reads that froze the web process on a saturated disk (§20).
 *
 * On the NAS a page not in cache costs ~100 ms and better-sqlite3 blocks while it waits, so a
 * statement costs what it touches rather than what it computes. Measured there:
 *
 * - The performer list read ~1,170 pages (4-17 s): every tag count joins `Media` on `listable`,
 *   which read each assigned item's whole row to test one column. `idx_Media_listable_id` makes
 *   that check index-only. It is UNIQUE so the planner picks it over the primary key -- two
 *   unique lookups on "id" tie and the covering one wins; a plain index always loses.
 * - The standing-failure count read ~620 pages: a scan of the queue for its few failures, then
 *   for each one every job of its kind. `idx_Job_failed` starts from the failures and
 *   `idx_Job_kind_mediaId` answers "anything queued since?" from one item's rows.
 * - "Is a scan running?", now on every library poll, read the whole scan history, which is
 *   never pruned. `idx_Scan_running` holds the one row, or none.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_Media_listable_id"
            ON "Media" ("id") WHERE "listable" = 1;
         CREATE INDEX IF NOT EXISTS "idx_Job_kind_mediaId" ON "Job" ("kind", "mediaId");
         CREATE INDEX IF NOT EXISTS "idx_Job_failed"
            ON "Job" ("kind", "mediaId") WHERE "state" = 'failed';
         CREATE INDEX IF NOT EXISTS "idx_Scan_running" ON "Scan" ("startedAt")
            WHERE "state" = 'running';`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP INDEX IF EXISTS "idx_Scan_running";
         DROP INDEX IF EXISTS "idx_Job_failed";
         DROP INDEX IF EXISTS "idx_Job_kind_mediaId";
         DROP INDEX IF EXISTS "idx_Media_listable_id";`
    );
}
