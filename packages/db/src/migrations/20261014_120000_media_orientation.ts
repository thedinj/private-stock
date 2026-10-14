import type { Database } from "better-sqlite3";

/**
 * Orientation as a column the planner can use (§14e, §20 "The disk, not the CPU").
 *
 * The filter compared `width` with `height` on every row it considered, and no index holds
 * either, so a portrait shuffle read each item's whole row to decide: 1,429 pages for the videos
 * on the production replica, against 275 for the same walk with no orientation at all. Its count
 * and the other kind's tab paid the same again.
 *
 * - **`Media.orientation`**, a VIRTUAL generated column: `'landscape'`, `'portrait'` or
 *   `'square'`, and NULL when either side is unknown -- exactly what the comparisons said. It is
 *   computed from the two columns rather than kept beside them, so a re-probe cannot leave it
 *   stale; that was the reason the comparison had been preferred to a column, and a generated
 *   one answers it. `ADD COLUMN` accepts only VIRTUAL, which is the kind wanted anyway: nothing
 *   is stored in the row, only in the index below.
 * - **`idx_Media_list_orientation`** `("listRootId", "orientation", "kind", "id")`, partial on
 *   `listable` like every list index, so a walk filtered by orientation is a range of index
 *   entries that carries everything a kept order and a count read.
 *
 * Nothing to backfill: a generated column has a value for every row the moment it exists, and
 * the index is built from them. Idempotent: a database built by `init.ts` already has both and
 * is then stamped by replaying the history.
 */
const hasColumn = (db: Database): boolean =>
    // `table_xinfo`, not `table_info`: the latter leaves generated columns out.
    db.prepare(`SELECT 1 FROM pragma_table_xinfo('Media') WHERE "name" = 'orientation'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "Media" ADD COLUMN "orientation" TEXT GENERATED ALWAYS AS (CASE WHEN "width" > "height" THEN 'landscape'
                WHEN "height" > "width" THEN 'portrait' WHEN "width" = "height" THEN 'square'
                END) VIRTUAL;`
        );
    }

    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_list_orientation"
            ON "Media" ("listRootId", "orientation", "kind", "id") WHERE "listable" = 1;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Media_list_orientation";`);

    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "Media" DROP COLUMN "orientation";`);
    }
}
