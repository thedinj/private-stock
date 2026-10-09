import { db } from "../db.js";

/**
 * A viewer's own marks on a tag (§6 "Favourite tags").
 *
 * Every function takes `userId` explicitly. Rows are created on demand, like `UserMedia`'s: a
 * person who has never marked a tag has no row, which is why the browse query LEFT JOINs.
 * Visibility is not decided here -- the service checks the tag is one the viewer can see.
 */

// Booleans are 1 or NULL, never 0 — the partial index depends on it.
export const setFavorite = (userId: string, tagId: string, favorite: boolean): void => {
    db.prepare(
        `INSERT INTO "UserTag" ("userId", "tagId", "favorite", "updatedAt")
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("userId", "tagId")
         DO UPDATE SET "favorite" = excluded."favorite", "updatedAt" = CURRENT_TIMESTAMP`
    ).run(userId, tagId, favorite ? 1 : null);
};

export const isFavorite = (userId: string, tagId: string): boolean =>
    db
        .prepare(
            `SELECT 1 FROM "UserTag"
              WHERE "userId" = ? AND "tagId" = ? AND "favorite" IS NOT NULL`
        )
        .get(userId, tagId) !== undefined;
