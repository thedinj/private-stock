import { db } from "../db.js";

/**
 * One row per user per room holding their home page arrangement (§6, §21).
 *
 * A user with no row has not arranged anything and inherits the admin default. That is why
 * there is no "reset" write: resetting is deleting the row, and the absence then continues to
 * track the default as an admin changes it, where a copied-in default would silently freeze.
 */

export const find = (userId: string, domain: string): string | undefined =>
    (
        db
            .prepare(`SELECT "rowsJson" FROM "HomeLayout" WHERE "userId" = ? AND "domain" = ?`)
            .get(userId, domain) as { rowsJson: string } | undefined
    )?.rowsJson;

export const save = (userId: string, domain: string, rowsJson: string): void => {
    db.prepare(
        `INSERT INTO "HomeLayout" ("userId", "domain", "rowsJson", "updatedAt")
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("userId", "domain") DO UPDATE
            SET "rowsJson" = excluded."rowsJson", "updatedAt" = CURRENT_TIMESTAMP`
    ).run(userId, domain, rowsJson);
};

/** Removing the row is how a user goes back to inheriting the default, in that room. */
export const clear = (userId: string, domain: string): void => {
    db.prepare(`DELETE FROM "HomeLayout" WHERE "userId" = ? AND "domain" = ?`).run(userId, domain);
};
