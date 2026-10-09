import type { Database } from "better-sqlite3";

/**
 * OCR tuning runs (§5d "Tuning against expected text").
 *
 * A search for the settings that best read what an administrator says the bench's videos
 * contain. One row per run, its result stored whole as JSON; history is capped at a few runs.
 *
 * Idempotent, like every migration here: a database built by `init.ts` already has the table.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "OcrTuneRun" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "state" TEXT NOT NULL DEFAULT 'pending' CHECK("state" IN ('pending', 'running', 'done', 'failed', 'cancelled')),
            "mode" TEXT NOT NULL CHECK("mode" IN ('quick', 'thorough')),
            "costWeight" TEXT NOT NULL CHECK("costWeight" IN ('low', 'medium', 'high')),
            "stage" TEXT CHECK("stage" IS NULL OR length("stage") <= 200),
            "progress" REAL NOT NULL DEFAULT 0 CHECK("progress" BETWEEN 0 AND 1),
            "resultJson" TEXT CHECK("resultJson" IS NULL OR length("resultJson") <= 2000000),
            "error" TEXT CHECK("error" IS NULL OR length("error") <= 500),
            "createdByUserId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_OcrTuneRun_createdAt" ON "OcrTuneRun" ("createdAt");
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_OcrTuneRun_createdAt";
        DROP TABLE IF EXISTS "OcrTuneRun";
    `);
}
