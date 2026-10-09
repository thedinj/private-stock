import type { Database } from "better-sqlite3";

/**
 * The OCR test bench (§5d "Settings and the test bench").
 *
 * One video read under the current settings and under a candidate, side by side, as scratch
 * rows that never touch "MediaText". One row per video and side, replaced by each new run.
 *
 * Idempotent, like every migration here: a database built by `init.ts` already has the table.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "OcrTrial" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "side" TEXT NOT NULL CHECK("side" IN ('current', 'candidate')),
            "settingsJson" TEXT NOT NULL CHECK(length("settingsJson") <= 4000),
            "state" TEXT NOT NULL DEFAULT 'pending' CHECK("state" IN ('pending', 'running', 'done', 'failed')),
            "findingsJson" TEXT CHECK("findingsJson" IS NULL OR length("findingsJson") <= 200000),
            "framesRead" INTEGER,
            "elapsedMs" INTEGER,
            "error" TEXT CHECK("error" IS NULL OR length("error") <= 500),
            "createdByUserId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL,
            UNIQUE ("mediaId", "side")
        );
    `);
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "OcrTrial";`);
}
