import type { Database } from "better-sqlite3";

/**
 * Duplicate groups are of one room (§21 "Duplicates stay in their room").
 *
 * Clustering knew nothing of rooms, so one group could hold a Cellar copy and a Game Room copy,
 * and each room's Review queue showed the other's titles and covers. The worker now joins only
 * items of the same room; this takes apart the groups written before it did.
 *
 * Data only. Each group whose members' originals are in more than one room is deleted (its
 * members go with it), and those members' clustering marks are forgotten, so the next pass seeds
 * from them and builds one group per room -- the same path every group is built by, rather than a
 * second way of splitting them here, and a pass is queued so that happens without waiting for the
 * next hash. A group split this way comes back unreviewed: what somebody
 * decided about it was a decision about copies in two rooms.
 *
 * Idempotent: once no group spans two rooms there is nothing to delete. Nothing to undo -- the
 * groups it removes are not ones the app can produce any more.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TEMP TABLE "_crossRoomGroup" AS
             SELECT dm."groupId" AS "id"
               FROM "DupeMember" dm
               JOIN "MediaFileLink" fl ON fl."mediaId" = dm."mediaId" AND fl."role" = 'original'
               JOIN "MediaFile" f ON f."id" = fl."fileId"
               JOIN "MediaRoot" r ON r."id" = f."rootId"
              GROUP BY dm."groupId"
             HAVING count(DISTINCT r."domain") > 1;

         DELETE FROM "DupeClustered"
          WHERE "mediaId" IN (
              SELECT "mediaId" FROM "DupeMember"
               WHERE "groupId" IN (SELECT "id" FROM "_crossRoomGroup"));

         DELETE FROM "DupeMember" WHERE "groupId" IN (SELECT "id" FROM "_crossRoomGroup");
         DELETE FROM "DupeGroup" WHERE "id" IN (SELECT "id" FROM "_crossRoomGroup");

         DROP TABLE "_crossRoomGroup";

         INSERT INTO "Job" ("id", "kind", "priority", "updatedAt")
         VALUES (lower(hex(randomblob(16))), 'dupes', 200, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING;`
    );
}

export function down(): void {
    // Nothing to put back: see above.
}
