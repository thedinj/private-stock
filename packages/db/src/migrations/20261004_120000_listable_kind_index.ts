import type { Database } from "better-sqlite3";

/**
 * The per-kind tag counts, made index-only like the plain ones (§20).
 *
 * `idx_Media_listable_id` made every tag count that joins `Media` only to test `listable` read
 * the index instead of the row. The counts split by kind -- the Tags page's video and photo
 * numbers (`browseTags`) and a tag's own (`countByKind`) -- also read `kind`, which that index
 * does not hold, so they still fetched each assigned item's whole row: ~990 pages for a page of
 * performers on a production-sized library, ~220 with this index; a tag's own count 84 -> 53.
 *
 * This index holds both. It is UNIQUE for the same reason the first one is -- the planner only
 * prefers a partial index to the primary key when the probe pins every column of a unique one
 * -- and the queries state `kind IN (every kind)` so that both columns are pinned.
 *
 * It sits beside `idx_Media_listable_id` rather than replacing it. Replacing it measured
 * within a few pages on every tag query, but only with the always-true term added to every
 * join that tests `listable` -- forget it and that join is back on the row, silently -- and
 * the term is not harmless: stated where the `MediaTag` side is pinned by a literal
 * (`"userId" IS NULL` rather than a bound `IS :owner`), it turned the facet counts around to
 * start from `Media` by kind and read the library, ~2,100 pages against ~210. `kind` never
 * changes after insert, so the cost is one more entry on insert, delete and `listable` flips.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_Media_listable_id_kind"
            ON "Media" ("id", "kind") WHERE "listable" = 1;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Media_listable_id_kind";`);
}
