import type { Database } from "better-sqlite3";

/**
 * Which domain a library belongs to (§21): family, cellar or games.
 *
 * Every library that exists already belongs to the cellar, which is what it was built for. The
 * value is not CHECKed, like `Tag.kind`, so the list lives in `domainKinds` and widening it is
 * an edit. It is chosen when a library is added and is not edited afterwards.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('MediaRoot') WHERE "name" = 'domain'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "MediaRoot" ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'cellar' CHECK(length("domain") BETWEEN 1 AND 32);`
        );
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "MediaRoot" DROP COLUMN "domain";`);
    }
}
