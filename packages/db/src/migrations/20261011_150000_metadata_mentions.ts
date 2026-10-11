import type { Database } from "better-sqlite3";

/**
 * `MediaMention.field` gains `'metadata'`: a tag's name found in the file's own tags — a
 * creator's handle in a comment, a site in an artist field (§5b "One rule for names").
 *
 * SQLite cannot alter a CHECK, so the table is rebuilt: the old one moved aside, the new one
 * created exactly as `init.ts` writes it (the drift test compares the stored SQL), the rows
 * copied across. The index goes with the old table and is made again on the new one, after the
 * old one is dropped so the name is free. Nothing references the table.
 *
 * Nothing to backfill: the `metadata` stage asks for a reindex of every item whose tags it
 * stores, and the index stage writes that item's mentions.
 *
 * Idempotent: a database that already allows the value is left alone. `down` removes the rows
 * only the new value permits before narrowing the CHECK again.
 */
const allowsMetadata = (db: Database): boolean =>
    (
        db
            .prepare(
                `SELECT "sql" FROM sqlite_master WHERE "type" = 'table' AND "name" = 'MediaMention'`
            )
            .get() as { sql: string }
    ).sql.includes("'metadata'");

const rebuild = (db: Database, fields: string): void => {
    db.exec(`
        ALTER TABLE "MediaMention" RENAME TO "MediaMention_old";

        CREATE TABLE "MediaMention" (
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "field" TEXT NOT NULL CHECK("field" IN (${fields})),
            PRIMARY KEY ("mediaId", "tagId", "field")
        ) WITHOUT ROWID;

        INSERT INTO "MediaMention" ("mediaId", "tagId", "field")
        SELECT "mediaId", "tagId", "field" FROM "MediaMention_old";

        DROP TABLE "MediaMention_old";

        CREATE INDEX IF NOT EXISTS "idx_MediaMention_tag" ON "MediaMention" ("tagId", "mediaId");
    `);
};

export function up(db: Database): void {
    if (!allowsMetadata(db)) {
        rebuild(db, `'filename', 'title', 'screen', 'metadata'`);
    }
}

export function down(db: Database): void {
    if (allowsMetadata(db)) {
        db.exec(`DELETE FROM "MediaMention" WHERE "field" = 'metadata';`);
        rebuild(db, `'filename', 'title', 'screen'`);
    }
}
