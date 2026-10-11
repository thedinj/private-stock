import type { Database } from "better-sqlite3";

/**
 * `MediaAttribute.source` gains `'embedded'`: what a file says about itself in its own tags
 * (§5b), kept by the `metadata` stage.
 *
 * SQLite cannot alter a CHECK, so the table is rebuilt: the old one moved aside, the new one
 * created exactly as `init.ts` writes it (the drift test compares the stored SQL), the rows
 * copied across. Nothing references the table, so nothing else is touched.
 *
 * Idempotent: a database that already allows the value is left alone. `down` removes the rows
 * that only the new value permits before narrowing the CHECK again.
 */
const allowsEmbedded = (db: Database): boolean =>
    (
        db
            .prepare(
                `SELECT "sql" FROM sqlite_master WHERE "type" = 'table' AND "name" = 'MediaAttribute'`
            )
            .get() as { sql: string }
    ).sql.includes("'embedded'");

const rebuild = (db: Database, sources: string): void => {
    db.exec(`
        ALTER TABLE "MediaAttribute" RENAME TO "MediaAttribute_old";

        CREATE TABLE "MediaAttribute" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "key" TEXT NOT NULL CHECK(length("key") BETWEEN 1 AND 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 2000),
            "source" TEXT NOT NULL DEFAULT 'scraper'
                CHECK("source" IN (${sources})),
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "key")
        );

        INSERT INTO "MediaAttribute" ("id", "mediaId", "key", "value", "source")
        SELECT "id", "mediaId", "key", "value", "source" FROM "MediaAttribute_old";

        DROP TABLE "MediaAttribute_old";
    `);
};

export function up(db: Database): void {
    if (!allowsEmbedded(db)) {
        rebuild(db, `'user', 'filename', 'scraper', 'ai', 'ocr', 'embedded'`);
    }
}

export function down(db: Database): void {
    if (allowsEmbedded(db)) {
        db.exec(`DELETE FROM "MediaAttribute" WHERE "source" = 'embedded';`);
        db.exec(`DELETE FROM "MediaStage" WHERE "stage" = 'metadata';`);
        rebuild(db, `'user', 'filename', 'scraper', 'ai', 'ocr'`);
    }
}
