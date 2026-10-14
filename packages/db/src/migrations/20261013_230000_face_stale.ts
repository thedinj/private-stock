import type { Database } from "better-sqlite3";

/**
 * What the references run must look at again (§5f "Only what changed").
 *
 * The `faceAnchors` run used to rebuild every reference, rescore every face and rewrite every
 * match and person in the library each time somebody named one face: tens of seconds of reads
 * on the NAS's disks, and some 70,000 rows deleted and written back, mostly unchanged. It now
 * keeps its work between runs and redoes only what changed -- and these triggers are how it
 * knows what that is, whichever path changed it: a press, an undo, a tag merge, an untag, a
 * library switched off, a cascade from a deleted item.
 *
 * - `'item'`: an item whose faces were found again, deleted, confirmed, set aside or taken out of
 *   grouping -- its people are gathered again and its faces scored afresh.
 * - `'tag'`: a library performer whose reference may have moved -- their confirmed faces, their
 *   tagged items, their refusals, "no single face", or the tag itself.
 *
 * Marking too much costs a little arithmetic, since an unmoved reference rescores nothing;
 * marking too little would leave a score stale, so each trigger errs wide.
 *
 * `FaceMatch` goes: every face's best match, which nothing has read since Matches, "Looks like
 * them" and Likely went (§5f "New people") -- yet each run scored all 74,000 faces against all
 * 300 references to rewrite its 56,000 rows. Suggestions, New people and Would tag read the
 * people in items, `FaceAppearance`, which stays.
 *
 * `idx_Face_tag` also gains `vectorIndex`, so a performer's confirmed faces are read from the
 * index alone: that read was 15 s on the NAS, a table probe per confirmed face.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "FaceStale" (
            "kind" TEXT NOT NULL CHECK("kind" IN ('tag', 'item')),
            "id" TEXT NOT NULL CHECK(length("id") <= 64),
            PRIMARY KEY ("kind", "id")
        ) WITHOUT ROWID;

        CREATE TRIGGER IF NOT EXISTS "Face_stale_ai" AFTER INSERT ON "Face"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('item', NEW."mediaId");
        END;

        CREATE TRIGGER IF NOT EXISTS "Face_stale_ad" AFTER DELETE ON "Face"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('item', OLD."mediaId");
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', OLD."tagId" WHERE OLD."tagId" IS NOT NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS "Face_stale_au"
            AFTER UPDATE OF "tagId", "scatteredAt", "skippedAt" ON "Face"
            WHEN OLD."tagId" IS NOT NEW."tagId" OR OLD."scatteredAt" IS NOT NEW."scatteredAt"
                 OR OLD."skippedAt" IS NOT NEW."skippedAt"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('item', NEW."mediaId");
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', OLD."tagId"
                 WHERE OLD."tagId" IS NOT NULL AND OLD."tagId" IS NOT NEW."tagId";
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', NEW."tagId"
                 WHERE NEW."tagId" IS NOT NULL AND OLD."tagId" IS NOT NEW."tagId";
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaTag_stale_ai" AFTER INSERT ON "MediaTag"
            WHEN NEW."userId" IS NULL
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', NEW."tagId"
                 WHERE EXISTS (SELECT 1 FROM "Tag" t WHERE t."id" = NEW."tagId"
                                  AND t."kind" = 'performer');
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaTag_stale_ad" AFTER DELETE ON "MediaTag"
            WHEN OLD."userId" IS NULL
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', OLD."tagId"
                 WHERE EXISTS (SELECT 1 FROM "Tag" t WHERE t."id" = OLD."tagId"
                                  AND t."kind" = 'performer');
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaTag_stale_au" AFTER UPDATE ON "MediaTag"
            WHEN OLD."userId" IS NULL OR NEW."userId" IS NULL
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', t."id" FROM "Tag" t
                 WHERE t."id" IN (OLD."tagId", NEW."tagId") AND t."kind" = 'performer';
        END;

        CREATE TRIGGER IF NOT EXISTS "FaceRefusal_stale_ai" AFTER INSERT ON "FaceRefusal"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', NEW."tagId");
        END;

        CREATE TRIGGER IF NOT EXISTS "FaceRefusal_stale_ad" AFTER DELETE ON "FaceRefusal"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', OLD."tagId");
        END;

        CREATE TRIGGER IF NOT EXISTS "PerformerNoFace_stale_ai" AFTER INSERT ON "PerformerNoFace"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', NEW."tagId");
        END;

        CREATE TRIGGER IF NOT EXISTS "PerformerNoFace_stale_ad" AFTER DELETE ON "PerformerNoFace"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', OLD."tagId");
        END;

        CREATE TRIGGER IF NOT EXISTS "Tag_stale_au" AFTER UPDATE OF "kind", "ownerId" ON "Tag"
            WHEN (OLD."kind" IS NOT NEW."kind" OR OLD."ownerId" IS NOT NEW."ownerId")
                 AND 'performer' IN (OLD."kind", NEW."kind")
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', NEW."id");
        END;

        CREATE TRIGGER IF NOT EXISTS "Tag_stale_ad" AFTER DELETE ON "Tag"
            WHEN OLD."kind" = 'performer'
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', OLD."id");
        END;

        CREATE TRIGGER IF NOT EXISTS "Media_stale_au" AFTER UPDATE OF "listable" ON "Media"
            WHEN OLD."listable" IS NOT NEW."listable"
                 AND EXISTS (SELECT 1 FROM "Face" f WHERE f."mediaId" = NEW."id")
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', mt."tagId" FROM "MediaTag" mt JOIN "Tag" t ON t."id" = mt."tagId"
                 WHERE mt."mediaId" = NEW."id" AND mt."userId" IS NULL AND t."kind" = 'performer';
        END;

        DROP INDEX IF EXISTS "idx_Face_tag";
        CREATE INDEX IF NOT EXISTS "idx_Face_tag"
            ON "Face" ("tagId", "mediaId", "vectorIndex") WHERE "tagId" IS NOT NULL;

        DROP INDEX IF EXISTS "idx_FaceMatch_tag";
        DROP TABLE IF EXISTS "FaceMatch";
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP TRIGGER IF EXISTS "Face_stale_ai";
        DROP TRIGGER IF EXISTS "Face_stale_ad";
        DROP TRIGGER IF EXISTS "Face_stale_au";
        DROP TRIGGER IF EXISTS "MediaTag_stale_ai";
        DROP TRIGGER IF EXISTS "MediaTag_stale_ad";
        DROP TRIGGER IF EXISTS "MediaTag_stale_au";
        DROP TRIGGER IF EXISTS "FaceRefusal_stale_ai";
        DROP TRIGGER IF EXISTS "FaceRefusal_stale_ad";
        DROP TRIGGER IF EXISTS "PerformerNoFace_stale_ai";
        DROP TRIGGER IF EXISTS "PerformerNoFace_stale_ad";
        DROP TRIGGER IF EXISTS "Tag_stale_au";
        DROP TRIGGER IF EXISTS "Tag_stale_ad";
        DROP TRIGGER IF EXISTS "Media_stale_au";
        DROP TABLE IF EXISTS "FaceStale";

        DROP INDEX IF EXISTS "idx_Face_tag";
        CREATE INDEX IF NOT EXISTS "idx_Face_tag" ON "Face" ("tagId", "mediaId") WHERE "tagId" IS NOT NULL;

        -- Empty: the next references run of the code that read it would fill it.
        CREATE TABLE IF NOT EXISTS "FaceMatch" (
            "faceId" TEXT NOT NULL PRIMARY KEY REFERENCES "Face" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "score" REAL NOT NULL,
            "second" REAL NOT NULL
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_FaceMatch_tag" ON "FaceMatch" ("tagId", "score");
    `);
}
