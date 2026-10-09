import type { Database } from "better-sqlite3";

/**
 * The tag counts, narrowed to what the viewer can see without reading each item's row (§6, §20).
 *
 * A tag's numbers -- its own video and photo counts, the Tags page's, who a performer appears
 * with -- counted every listable item, while the grid each number leads to shows only the
 * viewer's libraries. Narrowing them reads `listRootId`, which neither `idx_Media_listable_id`
 * nor `idx_Media_listable_id_kind` holds, so the count would be back to fetching every assigned
 * item's whole row: the ~990 pages per page of performers that the kind index removed.
 *
 * This index holds all three columns, and the statements name it with `INDEXED BY`.
 *
 * **It has to be fenced off from every other query, and the `kind IN` term is the fence.** The
 * library's own queries pin exactly these three columns -- `id` through a join, `kind` and
 * `listRootId` as filters -- so an index over them is the obvious probe for those too. Plain
 * or unique, it took the library count for a broad text match off its walk of
 * `idx_Media_list_*`, and a mentions query off starting from its matches (mediaRepo.test.ts
 * asserts both). SQLite uses a partial index only for a query whose WHERE contains the index's
 * terms, and `kind IN ('image', 'video')` -- always true, the CHECK constraint's list -- is
 * written by the tag counts (`tagRepo` `ANY_KIND`) and nothing else. A new kind has to be
 * added here too; until it is, those statements fail to prepare rather than quietly reading
 * rows, because `INDEXED BY` refuses an index it cannot use.
 *
 * Beside `idx_Media_listable_id_kind` rather than replacing it. The stage sweeps walk that one
 * end to end every pass (`stageRepo.listableWalk`), and a third column would nearly double the
 * pages each walk reads. The cost here is one more entry on insert, delete and `listable` flips.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_listable_id_kind_root"
            ON "Media" ("id", "kind", "listRootId")
            WHERE "listable" = 1 AND "kind" IN ('image', 'video');`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Media_listable_id_kind_root";`);
}
