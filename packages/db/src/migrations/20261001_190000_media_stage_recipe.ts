import type { Database } from "better-sqlite3";

/**
 * Which configuration produced a stage's outcome (§5d "What happens when OCR settings change").
 *
 * OCR's output depends on settings an administrator can change, and a change must not re-read
 * the library by itself. That leaves the library holding text read under several revisions of
 * the settings, and this is how it knows which: each outcome records the revision as its
 * recipe, and the settings page counts the items whose recipe is not the current one.
 *
 * Nullable with no default: every existing outcome predates the column, and null is what "read
 * before recipes were recorded" means. The settings page counts those as read under the
 * defaults (`OCR_RECIPE_UNRECORDED`), which is what they were.
 *
 * Idempotent: a database built by `init.ts` already has the column.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('MediaStage') WHERE "name" = 'recipe'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "MediaStage" ADD COLUMN "recipe" TEXT CHECK("recipe" IS NULL OR length("recipe") <= 100);`
        );
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "MediaStage" DROP COLUMN "recipe";`);
    }
}
