import type { Database } from "better-sqlite3";

/**
 * The OCR match queue's pending count, answered from an index (§5d "Counts", §20).
 *
 * The count walks a string's findings for the ones not dismissed, and `reviewState` was only on
 * the row, so every finding cost a page of `MediaText` — on the NAS ~100 ms each, for every pair
 * an accept moves. With the state in the index the walk never leaves it: a full recount of the
 * production replica fell from ~1,340 pages to ~220.
 *
 * The same index widened rather than a second one beside it. Every reader of the old one pins
 * `textNorm` and orders or probes by `mediaId`, which the wider one still serves; inserts write
 * one index either way, and `reviewState` changes only when somebody reviews the finding.
 *
 * Written out exactly as `init.ts` writes it, because the drift test compares the stored SQL.
 */
export function up(db: Database): void {
    db.exec(
        `DROP INDEX IF EXISTS "idx_MediaText_textNorm";
        CREATE INDEX IF NOT EXISTS "idx_MediaText_textNorm" ON "MediaText" ("textNorm", "mediaId", "reviewState");`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP INDEX IF EXISTS "idx_MediaText_textNorm";
        CREATE INDEX IF NOT EXISTS "idx_MediaText_textNorm" ON "MediaText" ("textNorm", "mediaId");`
    );
}
