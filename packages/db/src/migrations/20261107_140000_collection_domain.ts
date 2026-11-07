import type { Database } from "better-sqlite3";

/**
 * Which domain a playlist, a reel or a saved view belongs to (§21).
 *
 * Their contents are already narrowed — every item is read through the request's roots — but
 * their *names* are not, and a list of playlists in the Parlour must not include one named for
 * something in the Cellar. Everything made before domains existed was made in the cellar.
 */
const TABLES = ["Playlist", "Reel", "SavedFilter"] as const;

const hasColumn = (db: Database, table: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE "name" = 'domain'`).get(table) !==
    undefined;

export function up(db: Database): void {
    for (const table of TABLES) {
        if (!hasColumn(db, table)) {
            db.exec(
                `ALTER TABLE "${table}" ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'cellar' CHECK(length("domain") BETWEEN 1 AND 32);`
            );
        }
    }
}

export function down(db: Database): void {
    for (const table of TABLES) {
        if (hasColumn(db, table)) {
            db.exec(`ALTER TABLE "${table}" DROP COLUMN "domain";`);
        }
    }
}
