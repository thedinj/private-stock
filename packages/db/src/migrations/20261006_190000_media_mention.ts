import type { Database } from "better-sqlite3";

/**
 * Which tags an item's own text names (§5b "One rule for names").
 *
 * Nothing to backfill here: the worker's `mentionMatch` job fills the table when it starts, as
 * `ocrMatch` fills its own.
 *
 * Idempotent, like every migration here. The definitions are written out exactly as `init.ts`
 * writes them, because the drift test compares the stored SQL.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "MediaMention" (
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "field" TEXT NOT NULL CHECK("field" IN ('filename', 'title', 'screen')),
            PRIMARY KEY ("mediaId", "tagId", "field")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_MediaMention_tag" ON "MediaMention" ("tagId", "mediaId");`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "MediaMention";`);
}
