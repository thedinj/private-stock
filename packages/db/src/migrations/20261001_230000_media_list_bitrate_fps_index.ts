import type { Database } from "better-sqlite3";

/**
 * Index the library's bitrate and frame-rate sorts (§20).
 *
 * The same shape as every other per-sort index: partial on `listable`, the root leading, the
 * sort column next, `id` to break ties. Sorting by last viewed, added alongside these, has no
 * index here and needs none it could use -- it orders by the viewer's `UserMedia` row, as
 * `rating` does.
 *
 * `IF NOT EXISTS` makes it idempotent for a database built by `init.ts` and then stamped.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_list_bitrate"
            ON "Media" ("listRootId", "bitrate", "id") WHERE "listable" = 1;
         CREATE INDEX IF NOT EXISTS "idx_Media_list_fps"
            ON "Media" ("listRootId", "fps", "id") WHERE "listable" = 1;`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP INDEX IF EXISTS "idx_Media_list_fps";
         DROP INDEX IF EXISTS "idx_Media_list_bitrate";`
    );
}
