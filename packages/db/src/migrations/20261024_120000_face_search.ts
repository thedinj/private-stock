import type { Database } from "better-sqlite3";

/**
 * "Who is this?" (§5f): a search of the library's faces from the frame on screen — the faces
 * found on it, and the stored faces nearest each. Scratch, kept a day.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "FaceSearch" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "atMs" INTEGER NOT NULL,
            "state" TEXT NOT NULL DEFAULT 'pending' CHECK("state" IN ('pending', 'running', 'done', 'failed')),
            "resultJson" TEXT CHECK("resultJson" IS NULL OR length("resultJson") <= 400000),
            "error" TEXT CHECK("error" IS NULL OR length("error") <= 500),
            "requestedByUserId" TEXT,
            "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("requestedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_FaceSearch_media" ON "FaceSearch" ("mediaId", "state");
        CREATE INDEX IF NOT EXISTS "idx_FaceSearch_requestedAt" ON "FaceSearch" ("requestedAt");
    `);
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "FaceSearch";`);
}
