import type { Database } from "better-sqlite3";

/**
 * No resume points (§14b).
 *
 * - **`UserMedia.resumePositionMs` goes**, with the index behind "Continue watching". Nothing is
 *   long enough here to be watched across sittings, and the position save was the most frequent
 *   write in the app (§20). Within one visit the player still returns to where it was, from
 *   memory in the page; nothing about it reaches the server.
 * - **`idx_UserMedia_viewed`** replaces it, for the "Recently viewed" shelf that takes its place.
 * - **Stored home layouts are rewritten**: every per-user layout and the admin default that
 *   named the `continueWatching` shelf names `recentlyViewed` instead. A layout that no longer
 *   parses falls back to the default wholesale, so leaving the old name would silently discard
 *   somebody's arrangement.
 *
 * Idempotent: a database built by `init.ts` has neither the column nor the old index and is
 * then stamped by replaying the history, and SQLite has no `DROP COLUMN IF EXISTS`.
 */
const hasColumn = (db: Database): boolean =>
    db
        .prepare(`SELECT 1 FROM pragma_table_info('UserMedia') WHERE "name" = 'resumePositionMs'`)
        .get() !== undefined;

const renameShelf = (db: Database, from: string, to: string): void => {
    const before = `"builtin":"${from}"`;
    const after = `"builtin":"${to}"`;

    db.prepare(
        `UPDATE "HomeLayout" SET "rowsJson" = replace("rowsJson", ?, ?)
          WHERE instr("rowsJson", ?) > 0`
    ).run(before, after, before);
    db.prepare(
        `UPDATE "Setting" SET "value" = replace("value", ?, ?)
          WHERE "key" = 'home.defaultLayout' AND instr("value", ?) > 0`
    ).run(before, after, before);
};

export function up(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_UserMedia_resume";`);

    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "UserMedia" DROP COLUMN "resumePositionMs";`);
    }

    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_UserMedia_viewed"
            ON "UserMedia" ("userId", "lastViewedAt") WHERE "lastViewedAt" IS NOT NULL;`
    );

    renameShelf(db, "continueWatching", "recentlyViewed");
}

export function down(db: Database): void {
    renameShelf(db, "recentlyViewed", "continueWatching");

    db.exec(`DROP INDEX IF EXISTS "idx_UserMedia_viewed";`);

    if (!hasColumn(db)) {
        db.exec(`ALTER TABLE "UserMedia" ADD COLUMN "resumePositionMs" INTEGER;`);
    }

    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_UserMedia_resume"
            ON "UserMedia" ("userId", "lastViewedAt") WHERE "resumePositionMs" IS NOT NULL;`
    );
}
