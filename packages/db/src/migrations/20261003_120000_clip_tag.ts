import type { Database } from "better-sqlite3";

/**
 * Tags on clips (§14d "Tagging clips").
 *
 * The library's own vocabulary, assigned to a span rather than to a whole item: a separate join
 * table, so "the video is about the pool" and "this span is somebody jumping in" stay two facts.
 * No "userId" column -- a clip's assignments are always for the clip's owner, and the pairing
 * rule that keeps a private tag on its owner's clips is enforced in clipTagRepo.
 *
 * `TagBatch.clipCount` lets a bulk tagging of clips be described and withdrawn exactly as a bulk
 * tagging of items is. NULL is an item batch; set is a clip batch, whose "mediaCount" is 0.
 */
const hasClipCount = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('TagBatch') WHERE "name" = 'clipCount'`).get() !==
    undefined;

/** Idempotent: a database built by `init.ts` already has both and is then stamped by replay. */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "ClipTag" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "clipId" TEXT NOT NULL,
            "tagId" TEXT NOT NULL,
            "position" INTEGER,
            "batchId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("clipId") REFERENCES "Clip" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("batchId") REFERENCES "TagBatch" ("id") ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_ClipTag_unique" ON "ClipTag" ("clipId", "tagId");
        CREATE INDEX IF NOT EXISTS "idx_ClipTag_tagId" ON "ClipTag" ("tagId");
        CREATE INDEX IF NOT EXISTS "idx_ClipTag_batchId"
            ON "ClipTag" ("batchId") WHERE "batchId" IS NOT NULL;
    `);
    if (!hasClipCount(db)) {
        db.exec(`ALTER TABLE "TagBatch" ADD COLUMN "clipCount" INTEGER;`);
    }
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "ClipTag";`);
    if (hasClipCount(db)) {
        db.exec(`ALTER TABLE "TagBatch" DROP COLUMN "clipCount";`);
    }
}
