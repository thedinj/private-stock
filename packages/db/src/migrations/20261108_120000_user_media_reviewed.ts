import type { Database } from "better-sqlite3";

/**
 * When this viewer finished deciding about an item (§14d "Reviewing recordings for a reel").
 *
 * Not `watchedAt`: that is set by thirty seconds of playback, and a recording opened ten seconds
 * before its end never gets there. Reviewed is the explicit "I have been through this one",
 * whether or not anything was cut from it. A timestamp, null when not reviewed, like `watchedAt`.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('UserMedia') WHERE "name" = 'reviewedAt'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(`ALTER TABLE "UserMedia" ADD COLUMN "reviewedAt" DATETIME;`);
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "UserMedia" DROP COLUMN "reviewedAt";`);
    }
}
