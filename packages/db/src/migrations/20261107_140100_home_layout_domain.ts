import type { Database } from "better-sqlite3";

/**
 * A home page per room (§21): `HomeLayout` keyed by `(userId, domain)` rather than by user.
 *
 * A shelf names a playlist or a saved view, and those belong to a room now. One arrangement
 * shared by every room would show the Parlour a row of shelves it cannot open, each still
 * carrying the title it was given in the Cellar. SQLite cannot change a primary key in place, so
 * the table is rebuilt; every arrangement that exists was made in the cellar.
 */
const hasDomain = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('HomeLayout') WHERE "name" = 'domain'`).get() !==
    undefined;

export function up(db: Database): void {
    if (hasDomain(db)) {
        return;
    }

    db.exec(`
        CREATE TABLE "HomeLayout_new" (
            "userId" TEXT NOT NULL,
            "domain" TEXT NOT NULL CHECK(length("domain") BETWEEN 1 AND 32),
            "rowsJson" TEXT NOT NULL CHECK(length("rowsJson") <= 20000),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "domain"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );
        INSERT INTO "HomeLayout_new" ("userId", "domain", "rowsJson", "updatedAt")
            SELECT "userId", 'cellar', "rowsJson", "updatedAt" FROM "HomeLayout";
        DROP TABLE "HomeLayout";
        ALTER TABLE "HomeLayout_new" RENAME TO "HomeLayout";
    `);
}

export function down(db: Database): void {
    if (!hasDomain(db)) {
        return;
    }

    // Only the cellar's arrangements survive: the old table had room for one per person.
    db.exec(`
        CREATE TABLE "HomeLayout_old" (
            "userId" TEXT NOT NULL PRIMARY KEY,
            "rowsJson" TEXT NOT NULL CHECK(length("rowsJson") <= 20000),
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );
        INSERT INTO "HomeLayout_old" ("userId", "rowsJson", "updatedAt")
            SELECT "userId", "rowsJson", "updatedAt" FROM "HomeLayout" WHERE "domain" = 'cellar';
        DROP TABLE "HomeLayout";
        ALTER TABLE "HomeLayout_old" RENAME TO "HomeLayout";
    `);
}
