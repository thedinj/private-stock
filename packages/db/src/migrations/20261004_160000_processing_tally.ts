import type { Database } from "better-sqlite3";

/**
 * The processing view's numbers, kept rather than counted (§13c, §20).
 *
 * Opening admin → Processing froze the site for 9–15 s on the NAS, and held the worker's job
 * claim for 8 s. Measured on a replica of the real library (13k items, 90k stage rows), the view
 * read ~6,800 pages to draw a dozen bars:
 *
 * - **The stage totals** were a covering scan of `idx_MediaStage_stage_state_version`: ~545 pages,
 *   3.1 s in production. Covering already, and still the floor for any query that counts the
 *   table, since a count visits every entry.
 * - **The subtraction of unlisted items** was meant to start from `idx_Media_unlisted` (249
 *   items) and was planned the other way round -- `INDEXED BY` pins an index, not a join order --
 *   so it walked every stage row and read each one's table row for `mediaId`: ~2,640 pages, 7 s.
 *   Even driven from the unlisted side, their 1,400 stage rows sit on ~1,000 scattered pages.
 * - **The denominator** joined every item to its link and file: ~3,450 pages, 4.2 s.
 *
 * `MediaStageTally` holds the first two already subtracted: per (stage, state, version), how many
 * stage rows belong to an item the library shows. Reading it is one or two pages, whatever the
 * size of the library. It is maintained by the triggers below and never by application code, for
 * the reason the `Media` list columns and `MediaTextString` are: a stale count is a bar that is
 * silently wrong. The write cost is one row of a table of ~20 rows -- a page that every stage
 * write touches and so is always cached -- against the per-job writes of four indexes already.
 *
 * Five triggers, because a stage row can enter or leave the count from either side:
 *
 * - a stage row is written, rewritten or removed while its item is listable;
 * - its item becomes listable or stops being (trashed, archived, missing, restored);
 * - its item is deleted. In a cascade the parent row is already gone when the child's delete
 *   trigger runs, so the stage-row trigger cannot tell a listable item's rows from an unlisted
 *   one's; the item's own `BEFORE DELETE` takes them away first, while it can still see them.
 *
 * Each item has at most one row per stage (the primary key), so an item contributes at most one
 * to any (stage, state, version) and the per-item adjustments are plain ±1 per matching row.
 * Rows that reach zero are left in place and filtered when read: there are a handful of them, and
 * deleting them would add a statement to every trigger.
 *
 * `idx_Media_listable_probed_kind` is the denominator's index: the same population
 * (`listable = 1` is the trigger-maintained form of "original file active and media", which is
 * what the old join spelled out), split by kind and by whether the probe has read it, in ~50
 * pages. The expression leads so no other query can seek on it; a query that only counts listable
 * items may scan it, which is the smallest index that answers that and harmless. `Media` is
 * written at insert, probe and listability changes -- rarely, against `MediaStage`'s per job.
 *
 * `idx_Media_unlisted` existed only for the subtraction and nothing else reads it, so it goes.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "MediaStageTally" (
            "stage" TEXT NOT NULL CHECK(length("stage") BETWEEN 1 AND 40),
            "state" TEXT NOT NULL CHECK("state" IN ('done', 'empty', 'failed', 'skipped')),
            "version" INTEGER NOT NULL,
            "count" INTEGER NOT NULL,
            PRIMARY KEY ("stage", "state", "version")
        );

        CREATE TRIGGER IF NOT EXISTS "MediaStage_tally_ai"
        AFTER INSERT ON "MediaStage"
        WHEN EXISTS (SELECT 1 FROM "Media" WHERE "id" = new."mediaId" AND "listable" = 1)
        BEGIN
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            VALUES (new."stage", new."state", new."version", 1)
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaStage_tally_ad"
        AFTER DELETE ON "MediaStage"
        WHEN EXISTS (SELECT 1 FROM "Media" WHERE "id" = old."mediaId" AND "listable" = 1)
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE "stage" = old."stage" AND "state" = old."state" AND "version" = old."version";
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaStage_tally_au"
        AFTER UPDATE OF "mediaId", "stage", "state", "version" ON "MediaStage"
        WHEN old."mediaId" IS NOT new."mediaId" OR old."stage" IS NOT new."stage"
          OR old."state" IS NOT new."state" OR old."version" IS NOT new."version"
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE "stage" = old."stage" AND "state" = old."state" AND "version" = old."version"
               AND EXISTS (SELECT 1 FROM "Media" WHERE "id" = old."mediaId" AND "listable" = 1);
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            SELECT new."stage", new."state", new."version", 1
             WHERE EXISTS (SELECT 1 FROM "Media" WHERE "id" = new."mediaId" AND "listable" = 1)
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS "Media_tally_au"
        AFTER UPDATE OF "listable" ON "Media"
        WHEN old."listable" IS NOT new."listable"
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE old."listable" = 1
               AND ("stage", "state", "version") IN (
                   SELECT "stage", "state", "version" FROM "MediaStage" WHERE "mediaId" = old."id");
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            SELECT "stage", "state", "version", 1 FROM "MediaStage"
             WHERE "mediaId" = new."id" AND new."listable" = 1
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS "Media_tally_bd"
        BEFORE DELETE ON "Media"
        WHEN old."listable" = 1
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE ("stage", "state", "version") IN (
                   SELECT "stage", "state", "version" FROM "MediaStage" WHERE "mediaId" = old."id");
        END;

        INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
        SELECT s."stage", s."state", s."version", count(*)
          FROM "MediaStage" s
          JOIN "Media" m ON m."id" = s."mediaId"
         WHERE m."listable" = 1
         GROUP BY s."stage", s."state", s."version";

        CREATE INDEX IF NOT EXISTS "idx_Media_listable_probed_kind"
            ON "Media" ("probedAt" IS NOT NULL, "kind") WHERE "listable" = 1;

        DROP INDEX IF EXISTS "idx_Media_unlisted";`
    );
}

export function down(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_unlisted" ON "Media" ("id") WHERE "listable" IS NULL;
         DROP INDEX IF EXISTS "idx_Media_listable_probed_kind";
         DROP TRIGGER IF EXISTS "Media_tally_bd";
         DROP TRIGGER IF EXISTS "Media_tally_au";
         DROP TRIGGER IF EXISTS "MediaStage_tally_au";
         DROP TRIGGER IF EXISTS "MediaStage_tally_ad";
         DROP TRIGGER IF EXISTS "MediaStage_tally_ai";
         DROP TABLE IF EXISTS "MediaStageTally";`
    );
}
