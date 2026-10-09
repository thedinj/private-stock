import type { Database } from "better-sqlite3";

/**
 * The faces each item shows, and what people have said about them (§5f).
 *
 * Nothing to backfill: the `faces` stage is opt-in and fills these as it runs.
 *
 * Idempotent, like every migration here. The definitions are written out exactly as `init.ts`
 * writes them, because the drift test compares the stored SQL.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "Face" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "vectorIndex" INTEGER NOT NULL,
            "atMs" INTEGER,
            "x" REAL NOT NULL,
            "y" REAL NOT NULL,
            "w" REAL NOT NULL,
            "h" REAL NOT NULL,
            "eyes" REAL NOT NULL,
            "score" REAL NOT NULL,
            "groupId" TEXT,
            "tagId" TEXT REFERENCES "Tag" ("id") ON DELETE SET NULL,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE ("mediaId", "vectorIndex")
        );

        CREATE INDEX IF NOT EXISTS "idx_Face_group" ON "Face" ("groupId") WHERE "groupId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_Face_tag" ON "Face" ("tagId", "mediaId") WHERE "tagId" IS NOT NULL;

        CREATE TABLE IF NOT EXISTS "FaceRefusal" (
            "faceId" TEXT NOT NULL REFERENCES "Face" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("faceId", "tagId")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_FaceRefusal_tag" ON "FaceRefusal" ("tagId", "faceId");`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "FaceRefusal"; DROP TABLE IF EXISTS "Face";`);
}
