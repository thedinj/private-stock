import type { Database } from "better-sqlite3";

/**
 * Tagging performers and sources from what OCR read (§5d).
 *
 * `OcrTagMatch` holds each (string, tag) pair the matcher found and what an administrator decided
 * about it; `OcrTagMatchSkip` the items left out when a pair was accepted. Nothing to backfill:
 * the worker's `ocrMatch` job fills the table when it next starts.
 *
 * Idempotent, like every migration here. The definitions are written out exactly as `init.ts`
 * writes them, because the drift test compares the stored SQL.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "OcrTagMatch" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "textNorm" TEXT NOT NULL CHECK(length("textNorm") BETWEEN 1 AND 500),
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "kind" TEXT NOT NULL CHECK("kind" IN ('exact', 'contains', 'near', 'manual')),
            "matchedText" TEXT NOT NULL CHECK(length("matchedText") BETWEEN 1 AND 500),
            "score" REAL NOT NULL CHECK("score" BETWEEN 0 AND 1),
            "state" TEXT CHECK("state" IS NULL OR "state" IN ('accepted', 'rejected')),
            "pendingCount" INTEGER NOT NULL DEFAULT 0,
            "batchId" TEXT REFERENCES "TagBatch" ("id") ON DELETE SET NULL,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE ("textNorm", "tagId")
        );

        -- The queue: pairs still waiting for a decision, and accepted ones with new items.
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_queued"
            ON "OcrTagMatch" ("textNorm") WHERE "state" IS NOT 'rejected' AND "pendingCount" > 0;
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_state" ON "OcrTagMatch" ("state", "textNorm");
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_tagId" ON "OcrTagMatch" ("tagId");
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_batchId"
            ON "OcrTagMatch" ("batchId") WHERE "batchId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_decidedByUserId"
            ON "OcrTagMatch" ("decidedByUserId") WHERE "decidedByUserId" IS NOT NULL;

        CREATE TABLE IF NOT EXISTS "OcrTagMatchSkip" (
            "matchId" TEXT NOT NULL REFERENCES "OcrTagMatch" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            PRIMARY KEY ("matchId", "mediaId")
        );

        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatchSkip_mediaId" ON "OcrTagMatchSkip" ("mediaId");`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP TABLE IF EXISTS "OcrTagMatchSkip";
         DROP TABLE IF EXISTS "OcrTagMatch";`
    );
}
