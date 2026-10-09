import type { Database } from "better-sqlite3";

/**
 * Other names for a tag (§5b "Aliases").
 *
 * A performer known by a maiden and a married name, a source with an old and a new domain: one
 * tag, several names. Until now the only answers were two tags, which split the items between
 * them, or a merge, which threw one name away -- and typing the lost name afterwards coined the
 * duplicate all over again.
 *
 * `kind` and `ownerId` are deliberately not copied here. They are read through `tagId`, so a
 * scope or facet change cannot leave an alias resolving in a vocabulary its tag has left. The
 * rule that a name means one tag per vocabulary spans two tables and is enforced in `tagRepo`,
 * the same trade-off the `Tag.ownerId` / `MediaTag.userId` pairing makes.
 *
 * Idempotent, like every migration here: a database built by `init.ts` already has the table
 * and is then stamped by replaying the history.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "TagAlias" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "tagId" TEXT NOT NULL,
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "nameNorm" TEXT NOT NULL CHECK(length("nameNorm") BETWEEN 1 AND 200),
            "createdById" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS "idx_TagAlias_unique"
            ON "TagAlias" ("tagId", "nameNorm");
        CREATE INDEX IF NOT EXISTS "idx_TagAlias_nameNorm" ON "TagAlias" ("nameNorm");
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_TagAlias_nameNorm";
        DROP INDEX IF EXISTS "idx_TagAlias_unique";
        DROP TABLE IF EXISTS "TagAlias";
    `);
}
