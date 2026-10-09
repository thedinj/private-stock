import type { Database } from "better-sqlite3";

/**
 * Index the items the library no longer shows (§13c).
 *
 * The processing view's stage totals counted every `MediaStage` row, including those of items
 * that had been trashed or archived, so a bar read `13,209 / 13,028` -- done exceeding the
 * library. `stageRepo.summary()` now subtracts the rows of unlisted items, and this is what
 * makes finding them cheap: partial, so it holds only the small set that is not listable
 * rather than the whole catalogue.
 *
 * `IF NOT EXISTS` makes it idempotent for a database built by `init.ts` and then stamped.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Media_unlisted" ON "Media" ("id") WHERE "listable" IS NULL;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Media_unlisted";`);
}
