import type { Database } from "better-sqlite3";

/**
 * OCR matches become rules, and the review becomes a queue of items (§5d "An accepted pair is a
 * rule").
 *
 * - `idx_MediaTag_ocr` holds the tags rules applied, newest first, for the log that checks them.
 * - The four `MediaTextString` indexes that served only the Strings tab's sorts and its default
 *   filter go with the tab. Each is written by the triggers on every finding, so keeping them
 *   was a cost with no reader. The count index stays: the Rules list walks it.
 *
 * Idempotent, like every migration here. Written out exactly as `init.ts` writes it, because the
 * drift test compares the stored SQL.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_MediaTag_ocr"
            ON "MediaTag" ("createdAt", "id") WHERE "source" = 'ocr' AND "userId" IS NULL;
        DROP INDEX IF EXISTS "idx_MediaTextString_confidence";
        DROP INDEX IF EXISTS "idx_MediaTextString_unreviewed_count";
        DROP INDEX IF EXISTS "idx_MediaTextString_unreviewed_confidence";
        DROP INDEX IF EXISTS "idx_MediaTextString_unreviewed_text";`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP INDEX IF EXISTS "idx_MediaTag_ocr";
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_confidence"
            ON "MediaTextString" ("confidenceSum" / "rowCount", "textNorm");
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_unreviewed_count"
            ON "MediaTextString" (-"rowCount", "textNorm") WHERE "unreviewedCount" > 0;
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_unreviewed_confidence"
            ON "MediaTextString" ("confidenceSum" / "rowCount", "textNorm") WHERE "unreviewedCount" > 0;
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_unreviewed_text"
            ON "MediaTextString" ("textNorm") WHERE "unreviewedCount" > 0;`
    );
}
