import type { Database } from "better-sqlite3";

/**
 * The Game Room no longer looks for look-alikes (§21 "Stages a room does not use").
 *
 * Its Look alike queue filled with clips of one map under one HUD, which the perceptual hash and
 * the tile prints cannot tell apart from copies of one clip, so the room now skips `phash` and
 * `tileprint`. The worker records `skipped` for anything new; this clears what was already found.
 *
 * Data only, for items whose list library is in the Game Room:
 *
 * - its look-alike groups (`near`) and their members. Identical groups stay: they come from the
 *   identity hash, which still runs.
 * - its "kept apart" verdicts between items that are not byte-identical. Only look-alike
 *   detection ever consulted those, and the Reviewed tab would go on listing them to take back.
 * - its perceptual hashes, image and video, which nothing but the look-alike pass reads.
 * - its `phash` and `tileprint` outcomes, set `skipped`, which settles them so the sweep does not
 *   offer them again and lets the orphan sweep reclaim the tile print files (it keeps only the
 *   files of `done` rows).
 * - its pending `phash` and `tileprint` jobs, which the worker would only settle as skipped.
 *
 * Idempotent: a second run finds nothing to delete and sets `skipped` to `skipped`. Nothing to
 * undo -- taking the skip back out of the profile is what would bring the fingerprints back, and
 * the sweep would rebuild them then.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TEMP TABLE "_gameMedia" AS
             SELECT m."id" FROM "Media" m
               JOIN "MediaRoot" r ON r."id" = m."listRootId"
              WHERE r."domain" = 'games';

         CREATE TEMP TABLE "_gameNearGroup" AS
             SELECT DISTINCT g."id" FROM "DupeGroup" g
               JOIN "DupeMember" dm ON dm."groupId" = g."id"
              WHERE g."kind" = 'near'
                AND dm."mediaId" IN (SELECT "id" FROM "_gameMedia");

         DELETE FROM "DupeMember" WHERE "groupId" IN (SELECT "id" FROM "_gameNearGroup");
         DELETE FROM "DupeGroup" WHERE "id" IN (SELECT "id" FROM "_gameNearGroup");

         DELETE FROM "DupeVerdict"
          WHERE ("aId" IN (SELECT "id" FROM "_gameMedia")
                 OR "bId" IN (SELECT "id" FROM "_gameMedia"))
            AND NOT EXISTS (
                SELECT 1
                  FROM "MediaFileLink" la
                  JOIN "MediaFile" fa ON fa."id" = la."fileId"
                  JOIN "MediaFileLink" lb ON lb."mediaId" = "DupeVerdict"."bId"
                                         AND lb."role" = 'original'
                  JOIN "MediaFile" fb ON fb."id" = lb."fileId"
                 WHERE la."mediaId" = "DupeVerdict"."aId" AND la."role" = 'original'
                   AND fa."contentHash" IS NOT NULL
                   AND fa."contentHash" = fb."contentHash");

         DELETE FROM "PhashImage" WHERE "mediaId" IN (SELECT "id" FROM "_gameMedia");
         DELETE FROM "PhashVideo" WHERE "mediaId" IN (SELECT "id" FROM "_gameMedia");

         UPDATE "MediaStage"
            SET "state" = 'skipped', "detail" = NULL, "at" = CURRENT_TIMESTAMP
          WHERE "stage" IN ('phash', 'tileprint')
            AND "state" <> 'skipped'
            AND "mediaId" IN (SELECT "id" FROM "_gameMedia");

         DELETE FROM "Job"
          WHERE "kind" IN ('phash', 'tileprint') AND "state" = 'pending'
            AND "mediaId" IN (SELECT "id" FROM "_gameMedia");

         DROP TABLE "_gameNearGroup";
         DROP TABLE "_gameMedia";`
    );
}

export function down(): void {
    // Nothing to put back: see above.
}
