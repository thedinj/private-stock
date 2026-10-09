import type { Database } from "better-sqlite3";

/**
 * A tag's picture (§6 "A tag's picture").
 *
 * - **`TagPicture`**: one picture somebody chose and one the `tagPictures` job read from a
 *   performer's confirmed faces, at most, for each tag. The files are under `tags/`; the rows say
 *   which item and moment each came from, and the crop.
 *
 * Nothing to backfill: the job draws the automatic pictures on its first run. Idempotent: a
 * database built by `init.ts` already has the table, and is then stamped by replaying the history.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "TagPicture" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "source" TEXT NOT NULL CHECK("source" IN ('user', 'auto')),
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 300),
            "smallRelPath" TEXT NOT NULL CHECK(length("smallRelPath") <= 300),
            "mediaId" TEXT REFERENCES "Media" ("id") ON DELETE SET NULL,
            "atMs" INTEGER,
            "cropX" REAL NOT NULL,
            "cropY" REAL NOT NULL,
            "cropW" REAL NOT NULL,
            "cropH" REAL NOT NULL,
            "setByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("tagId", "source")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_TagPicture_media"
            ON "TagPicture" ("mediaId") WHERE "mediaId" IS NOT NULL;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_TagPicture_media"; DROP TABLE IF EXISTS "TagPicture";`);
}
