import type { Database } from "better-sqlite3";

/**
 * Index the library's resolution sort (§20).
 *
 * Resolution is the short side, `MIN("width", "height")` -- the measure filter's definition --
 * and the sort orders by exactly that expression, so an index on the expression serves it the
 * way the per-column indexes serve the other sorts. Without it every page would sort the whole
 * matching library.
 *
 * `IF NOT EXISTS` makes it idempotent for a database built by `init.ts` and then stamped.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_list_resolution"
            ON "Media" ("listRootId", MIN("width", "height"), "id") WHERE "listable" = 1;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Media_list_resolution";`);
}
