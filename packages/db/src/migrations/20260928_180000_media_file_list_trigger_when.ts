import type { Database } from "better-sqlite3";

/**
 * Stop `MediaFile_list_au` rewriting `Media` rows when nothing it reads has changed (§20).
 *
 * The trigger recomputes the list columns (`listRootId`, `listSize`, `listRelPath`,
 * `listable`) and fired on *every* update to a file row. Each firing rewrote a `Media` row, the
 * hottest table the web process reads, so a file-hash pass — one update per file — or an
 * unchanged rescan pushed the whole catalogue through the WAL. In WAL mode a reader discards
 * its page cache whenever another connection has committed, which on the NAS turned primary-key
 * lookups in the web process into 0.3–1.5 s reads off a disk ffmpeg was using.
 *
 * The `WHEN` names exactly the columns the body reads. Same body either way, so `down` only
 * removes the condition.
 */
const BODY = `
    BEGIN
        UPDATE "Media" SET
            "listRootId" = (
                SELECT f."rootId" FROM "MediaFileLink" fl
                  JOIN "MediaFile" f ON f."id" = fl."fileId"
                 WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
            "listSize" = (
                SELECT f."size" FROM "MediaFileLink" fl
                  JOIN "MediaFile" f ON f."id" = fl."fileId"
                 WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
            "listRelPath" = (
                SELECT f."relPath" FROM "MediaFileLink" fl
                  JOIN "MediaFile" f ON f."id" = fl."fileId"
                 WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
            "listable" = (
                SELECT 1 FROM "MediaFileLink" fl
                  JOIN "MediaFile" f ON f."id" = fl."fileId"
                 WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original'
                   AND f."state" = 'active' AND f."classification" = 'media' LIMIT 1)
          WHERE "Media"."id" IN (
              SELECT "mediaId" FROM "MediaFileLink" WHERE "fileId" = new."id");
    END;
`;

/** Idempotent: a database built by `init.ts` already has this trigger and is then replayed. */
export function up(db: Database): void {
    db.exec(`
        DROP TRIGGER IF EXISTS "MediaFile_list_au";
        CREATE TRIGGER "MediaFile_list_au"
        AFTER UPDATE ON "MediaFile"
        WHEN old."rootId" IS NOT new."rootId"
          OR old."size" IS NOT new."size"
          OR old."relPath" IS NOT new."relPath"
          OR old."state" IS NOT new."state"
          OR old."classification" IS NOT new."classification"
        ${BODY}
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP TRIGGER IF EXISTS "MediaFile_list_au";
        CREATE TRIGGER "MediaFile_list_au"
        AFTER UPDATE ON "MediaFile"
        ${BODY}
    `);
}
