import type { Database } from "better-sqlite3";

/**
 * Every face decision is one act, listed and undoable (§5f "Decisions you can take back").
 *
 * - **`FaceDecision`**, one row per press — by a person or by the app tagging by itself: what was
 *   said (`is`, `isNot`, `notOnePerson`, `later`), of whom, from where, the tag batch it made, and
 *   when it was undone. Every confirmation, refusal, "can't tell" and "not one person" points at
 *   the press that wrote it (`Face.decisionId`, `FaceRefusal.decisionId`), so undoing one takes
 *   back exactly what it wrote and nothing else.
 * - **`ItemRefusal` replaces `MentionRefusal`**: "not them on this item" — said from "Find
 *   untagged", by untagging by hand, or of an item from its page — rather than only of an item
 *   whose text names them. Adding the tag again withdraws it, and the item's face refusals made
 *   the same way, by trigger: the later word wins.
 * - **What was decided before is carried over as decisions**, grouped by the press that wrote it:
 *   one statement stamps one `CURRENT_TIMESTAMP`, so the rows of one press share their performer,
 *   person and second. A confirmation and the refusals made with it are one decision; refusals
 *   alone, items refused, "can't tell" and "not one person" are their own. Tags faces applied by
 *   themselves are one app decision per batch. Each is listed in History and undoable there.
 *
 * `decisionId` on `Face` and `FaceRefusal` is a plain column rather than a foreign key: SQLite
 * cannot drop a column that is one, and a decision is never deleted once anything points at it.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
const hasColumn = (db: Database, table: string, column: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE "name" = ?`).get(table, column) !==
    undefined;

const hasTable = (db: Database, table: string): boolean =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE "type" = 'table' AND "name" = ?`).get(table) !==
    undefined;

const DECISION = `CREATE TABLE IF NOT EXISTS "FaceDecision" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "actor" TEXT NOT NULL CHECK("actor" IN ('user', 'app')),
            "userId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "verdict" TEXT NOT NULL CHECK("verdict" IN ('is', 'isNot', 'notOnePerson', 'later')),
            "tagId" TEXT REFERENCES "Tag" ("id") ON DELETE SET NULL,
            "surface" TEXT NOT NULL CHECK(length("surface") <= 32),
            "tagBatchId" TEXT REFERENCES "TagBatch" ("id") ON DELETE SET NULL,
            "faceCount" INTEGER NOT NULL DEFAULT 0,
            "itemCount" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "undoneAt" DATETIME,
            "undoneByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL
        );`;

const DECISION_INDEXES = `CREATE INDEX IF NOT EXISTS "idx_FaceDecision_created" ON "FaceDecision" ("createdAt" DESC);

        CREATE INDEX IF NOT EXISTS "idx_FaceDecision_tag"
            ON "FaceDecision" ("tagId", "createdAt" DESC) WHERE "tagId" IS NOT NULL;`;

const ITEM_REFUSAL = `CREATE TABLE IF NOT EXISTS "ItemRefusal" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "decisionId" TEXT REFERENCES "FaceDecision" ("id") ON DELETE SET NULL,
            PRIMARY KEY ("tagId", "mediaId")
        ) WITHOUT ROWID;`;

const REFERENCE_INDEXES = `CREATE INDEX IF NOT EXISTS "idx_Face_decision" ON "Face" ("decisionId") WHERE "decisionId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_FaceRefusal_decision"
            ON "FaceRefusal" ("decisionId") WHERE "decisionId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_ItemRefusal_decision"
            ON "ItemRefusal" ("decisionId") WHERE "decisionId" IS NOT NULL;`;

const FACE_AD = `CREATE TRIGGER IF NOT EXISTS "MediaTag_face_ad"
            AFTER DELETE ON "MediaTag" WHEN OLD."userId" IS NULL
        BEGIN
            UPDATE "Face"
               SET "tagId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL,
                   "decidedHow" = NULL, "decisionId" = NULL
             WHERE "mediaId" = OLD."mediaId" AND "tagId" = OLD."tagId";
        END;`;

const REFUSAL_AI = `CREATE TRIGGER IF NOT EXISTS "MediaTag_refusal_ai"
            AFTER INSERT ON "MediaTag" WHEN NEW."userId" IS NULL
        BEGIN
            DELETE FROM "ItemRefusal" WHERE "mediaId" = NEW."mediaId" AND "tagId" = NEW."tagId";
            DELETE FROM "FaceRefusal"
             WHERE "tagId" = NEW."tagId" AND "how" = 'item'
               AND "faceId" IN (SELECT "id" FROM "Face" WHERE "mediaId" = NEW."mediaId");
        END;`;

/** The decisions made before they were kept, from the rows they wrote. */
const backfill = (db: Database): void => {
    db.exec(`
        CREATE TEMP TABLE "legacyDecision" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "verdict" TEXT NOT NULL,
            "tagId" TEXT,
            "userId" TEXT,
            "at" TEXT,
            "createdAt" TEXT NOT NULL
        );
        CREATE INDEX "temp"."idx_legacyDecision_key" ON "legacyDecision" ("tagId", "verdict");

        -- Confirmations, one decision a press.
        INSERT INTO "legacyDecision"
        SELECT lower(hex(randomblob(16))), 'is', "tagId", "decidedByUserId", "decidedAt",
               coalesce("decidedAt", min("createdAt"))
          FROM "Face" WHERE "tagId" IS NOT NULL
         GROUP BY "tagId", "decidedByUserId", "decidedAt";

        -- Refusals: with the confirmations of the same press, or a refusal of their own.
        INSERT INTO "legacyDecision"
        SELECT lower(hex(randomblob(16))), 'isNot', r."tagId", r."decidedByUserId", r."decidedAt",
               r."decidedAt"
          FROM "FaceRefusal" r
         WHERE NOT EXISTS (SELECT 1 FROM "legacyDecision" d
                            WHERE d."tagId" = r."tagId" AND d."userId" IS r."decidedByUserId"
                              AND d."at" IS r."decidedAt")
         GROUP BY r."tagId", r."decidedByUserId", r."decidedAt";

        -- Items refused, with the face refusals of the same press where there were any.
        INSERT INTO "legacyDecision"
        SELECT lower(hex(randomblob(16))), 'isNot', i."tagId", i."decidedByUserId", i."decidedAt",
               i."decidedAt"
          FROM "ItemRefusal" i
         WHERE NOT EXISTS (SELECT 1 FROM "legacyDecision" d
                            WHERE d."tagId" = i."tagId" AND d."userId" IS i."decidedByUserId"
                              AND d."at" IS i."decidedAt")
         GROUP BY i."tagId", i."decidedByUserId", i."decidedAt";

        -- "Can't tell" and "Not one person", of faces nobody's.
        INSERT INTO "legacyDecision"
        SELECT lower(hex(randomblob(16))), 'later', NULL, "skippedByUserId", "skippedAt", "skippedAt"
          FROM "Face" WHERE "skippedAt" IS NOT NULL AND "tagId" IS NULL
         GROUP BY "skippedByUserId", "skippedAt";

        INSERT INTO "legacyDecision"
        SELECT lower(hex(randomblob(16))), 'notOnePerson', NULL, "scatteredByUserId", "scatteredAt",
               "scatteredAt"
          FROM "Face" WHERE "scatteredAt" IS NOT NULL AND "tagId" IS NULL
         GROUP BY "scatteredByUserId", "scatteredAt";

        INSERT INTO "FaceDecision" ("id", "actor", "userId", "verdict", "tagId", "surface", "createdAt")
        SELECT d."id", 'user',
               (SELECT u."id" FROM "User" u WHERE u."id" = d."userId"),
               d."verdict",
               (SELECT t."id" FROM "Tag" t WHERE t."id" = d."tagId"),
               'earlier', d."createdAt"
          FROM "legacyDecision" d;

        UPDATE "Face" SET "decisionId" = (
            SELECT d."id" FROM "legacyDecision" d
             WHERE d."verdict" = 'is' AND d."tagId" = "Face"."tagId"
               AND d."userId" IS "Face"."decidedByUserId" AND d."at" IS "Face"."decidedAt")
         WHERE "tagId" IS NOT NULL;

        UPDATE "Face" SET "decisionId" = (
            SELECT d."id" FROM "legacyDecision" d
             WHERE d."verdict" = 'later' AND d."userId" IS "Face"."skippedByUserId"
               AND d."at" IS "Face"."skippedAt")
         WHERE "skippedAt" IS NOT NULL AND "tagId" IS NULL;

        UPDATE "Face" SET "decisionId" = (
            SELECT d."id" FROM "legacyDecision" d
             WHERE d."verdict" = 'notOnePerson' AND d."userId" IS "Face"."scatteredByUserId"
               AND d."at" IS "Face"."scatteredAt")
         WHERE "scatteredAt" IS NOT NULL AND "tagId" IS NULL;

        UPDATE "FaceRefusal" SET "decisionId" = (
            SELECT d."id" FROM "legacyDecision" d
             WHERE d."verdict" IN ('is', 'isNot') AND d."tagId" = "FaceRefusal"."tagId"
               AND d."userId" IS "FaceRefusal"."decidedByUserId"
               AND d."at" IS "FaceRefusal"."decidedAt"
             ORDER BY d."verdict" LIMIT 1);

        UPDATE "ItemRefusal" SET "decisionId" = (
            SELECT d."id" FROM "legacyDecision" d
             WHERE d."verdict" IN ('is', 'isNot') AND d."tagId" = "ItemRefusal"."tagId"
               AND d."userId" IS "ItemRefusal"."decidedByUserId"
               AND d."at" IS "ItemRefusal"."decidedAt"
             ORDER BY d."verdict" LIMIT 1);

        -- A confirmation's tag, where the same press made one that is still there.
        UPDATE "FaceDecision" SET "tagBatchId" = (
            SELECT b."id" FROM "TagBatch" b
             WHERE b."userId" IS "FaceDecision"."userId" AND b."createdAt" = "FaceDecision"."createdAt"
               AND b."undoneAt" IS NULL
               AND EXISTS (SELECT 1 FROM "MediaTag" mt
                            WHERE mt."batchId" = b."id" AND mt."tagId" = "FaceDecision"."tagId")
             LIMIT 1)
         WHERE "surface" = 'earlier' AND "verdict" = 'is';

        -- What faces tagged by themselves: one app decision a batch.
        INSERT INTO "FaceDecision"
            ("id", "actor", "userId", "verdict", "tagId", "surface", "tagBatchId", "createdAt")
        SELECT lower(hex(randomblob(16))), 'app', b."userId", 'is', min(mt."tagId"), 'auto', b."id",
               b."createdAt"
          FROM "TagBatch" b JOIN "MediaTag" mt ON mt."batchId" = b."id" AND mt."source" = 'ai'
         WHERE b."undoneAt" IS NULL
         GROUP BY b."id";

        UPDATE "FaceDecision" SET
            "faceCount" =
                (SELECT count(*) FROM "Face" f WHERE f."decisionId" = "FaceDecision"."id") +
                (SELECT count(*) FROM "FaceRefusal" r WHERE r."decisionId" = "FaceDecision"."id"),
            "itemCount" = (
                SELECT count(DISTINCT "mediaId") FROM (
                    SELECT f."mediaId" FROM "Face" f WHERE f."decisionId" = "FaceDecision"."id"
                    UNION ALL
                    SELECT f."mediaId" FROM "FaceRefusal" r JOIN "Face" f ON f."id" = r."faceId"
                     WHERE r."decisionId" = "FaceDecision"."id"
                    UNION ALL
                    SELECT i."mediaId" FROM "ItemRefusal" i
                     WHERE i."decisionId" = "FaceDecision"."id"
                    UNION ALL
                    SELECT mt."mediaId" FROM "MediaTag" mt
                     WHERE mt."batchId" = "FaceDecision"."tagBatchId"));

        DROP TABLE "temp"."legacyDecision";
    `);
};

export function up(db: Database): void {
    db.exec(DECISION);
    db.exec(DECISION_INDEXES);

    if (!hasColumn(db, "Face", "decisionId")) {
        db.exec(
            `ALTER TABLE "Face" ADD COLUMN "decisionId" TEXT CHECK(length("decisionId") <= 64);`
        );
    }

    if (!hasColumn(db, "FaceRefusal", "decisionId")) {
        db.exec(
            `ALTER TABLE "FaceRefusal" ADD COLUMN "decisionId" TEXT CHECK(length("decisionId") <= 64);`
        );
    }

    const fresh = !hasTable(db, "ItemRefusal");

    db.exec(ITEM_REFUSAL);

    if (hasTable(db, "MentionRefusal")) {
        db.exec(
            `INSERT OR IGNORE INTO "ItemRefusal" ("tagId", "mediaId", "decidedByUserId", "decidedAt")
             SELECT "tagId", "mediaId", "decidedByUserId", "decidedAt" FROM "MentionRefusal";
             DROP TABLE "MentionRefusal";`
        );
    }

    db.exec(REFERENCE_INDEXES);
    db.exec(`DROP TRIGGER IF EXISTS "MediaTag_face_ad";`);
    db.exec(FACE_AD);
    db.exec(REFUSAL_AI);

    // Once: a database already carrying decisions has nothing to carry over.
    if (
        fresh &&
        (db.prepare(`SELECT count(*) AS "n" FROM "FaceDecision"`).get() as { n: number }).n === 0
    ) {
        backfill(db);
    }
}

export function down(db: Database): void {
    db.exec(`DROP TRIGGER IF EXISTS "MediaTag_refusal_ai";`);
    db.exec(`DROP TRIGGER IF EXISTS "MediaTag_face_ad";`);
    db.exec(
        `CREATE TRIGGER IF NOT EXISTS "MediaTag_face_ad"
            AFTER DELETE ON "MediaTag" WHEN OLD."userId" IS NULL
        BEGIN
            UPDATE "Face"
               SET "tagId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL,
                   "decidedHow" = NULL
             WHERE "mediaId" = OLD."mediaId" AND "tagId" = OLD."tagId";
        END;`
    );
    db.exec(`DROP INDEX IF EXISTS "idx_ItemRefusal_decision";
             DROP INDEX IF EXISTS "idx_FaceRefusal_decision";
             DROP INDEX IF EXISTS "idx_Face_decision";`);

    if (hasTable(db, "ItemRefusal")) {
        db.exec(
            `CREATE TABLE IF NOT EXISTS "MentionRefusal" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("tagId", "mediaId")
        ) WITHOUT ROWID;
             INSERT OR IGNORE INTO "MentionRefusal" ("tagId", "mediaId", "decidedByUserId", "decidedAt")
             SELECT "tagId", "mediaId", "decidedByUserId", "decidedAt" FROM "ItemRefusal";
             DROP TABLE "ItemRefusal";`
        );
    }

    if (hasColumn(db, "FaceRefusal", "decisionId")) {
        db.exec(`ALTER TABLE "FaceRefusal" DROP COLUMN "decisionId";`);
    }

    if (hasColumn(db, "Face", "decisionId")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "decisionId";`);
    }

    db.exec(`DROP INDEX IF EXISTS "idx_FaceDecision_tag";
             DROP INDEX IF EXISTS "idx_FaceDecision_created";
             DROP TABLE IF EXISTS "FaceDecision";`);
}
