import type { Database } from "better-sqlite3";

/**
 * Which domain a tag's vocabulary belongs to (§21 "One vocabulary per room").
 *
 * Tags hang off no root, so narrowing a request to one domain's libraries did not reach them:
 * the filter panel, the tag pages and face suggestions drew on every room's names. Every tag
 * that exists already was coined in the cellar, the only room that had libraries.
 *
 * The two partial uniques gain "domain" as their leading column, so "Jane" in the Parlour and
 * "Jane" in the Cellar are two people. Unchecked beyond its length, like `MediaRoot.domain`, and
 * never updated, so the `Tag_stale_*` triggers need not watch it.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('Tag') WHERE "name" = 'domain'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "Tag" ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'cellar' CHECK(length("domain") BETWEEN 1 AND 32);`
        );
    }

    db.exec(`
        DROP INDEX IF EXISTS "idx_Tag_unique_library";
        DROP INDEX IF EXISTS "idx_Tag_unique_owner";
        CREATE UNIQUE INDEX "idx_Tag_unique_library"
            ON "Tag" ("domain", "kind", "nameNorm") WHERE "ownerId" IS NULL;
        CREATE UNIQUE INDEX "idx_Tag_unique_owner"
            ON "Tag" ("domain", "kind", "nameNorm", "ownerId") WHERE "ownerId" IS NOT NULL;
    `);
}

/**
 * Back to one vocabulary. Fails if two domains have coined the same name, since the old indexes
 * cannot hold both, and choosing which to lose is not a rollback's decision.
 */
export function down(db: Database): void {
    if (!hasColumn(db)) {
        return;
    }

    db.exec(`
        DROP INDEX IF EXISTS "idx_Tag_unique_library";
        DROP INDEX IF EXISTS "idx_Tag_unique_owner";
        CREATE UNIQUE INDEX "idx_Tag_unique_library"
            ON "Tag" ("kind", "nameNorm") WHERE "ownerId" IS NULL;
        CREATE UNIQUE INDEX "idx_Tag_unique_owner"
            ON "Tag" ("kind", "nameNorm", "ownerId") WHERE "ownerId" IS NOT NULL;
        ALTER TABLE "Tag" DROP COLUMN "domain";
    `);
}
