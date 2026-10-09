import type { Database } from "better-sqlite3";

/**
 * A viewer's own marks on a tag (§6 "Favourite tags").
 *
 * The tag counterpart of `UserMedia`, and for the same reason: nothing subjective lives on the
 * shared row. Favourite is the only mark today; the table is named for the pair rather than the
 * feature so the next one has somewhere to go.
 *
 * Idempotent, like every migration here: a database built by `init.ts` already has the table
 * and is then stamped by replaying the history.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "UserTag" (
            "userId" TEXT NOT NULL,
            "tagId" TEXT NOT NULL,
            "favorite" INTEGER CHECK("favorite" IS NULL OR "favorite" = 1),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "tagId"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_UserTag_favorite"
            ON "UserTag" ("userId", "tagId") WHERE "favorite" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_UserTag_tag" ON "UserTag" ("tagId");
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_UserTag_tag";
        DROP INDEX IF EXISTS "idx_UserTag_favorite";
        DROP TABLE IF EXISTS "UserTag";
    `);
}
