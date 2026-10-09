import { db } from "../db.js";

/**
 * Small per-user UI preferences (§6) — gallery density, autoplay, preferred sort.
 *
 * A key/value table rather than columns, because these are the app's least consequential
 * state and the most likely to change shape: a new toggle should not be a schema change. The
 * values are strings; whatever structure they have is the caller's business, which keeps this
 * table from growing a vocabulary it would then have to validate.
 *
 * Deliberately *not* where anything an admin controls lives. Those are `Setting` rows with a
 * schema (§12b) — the distinction being that a preference is one person's taste and a setting
 * is policy for everyone.
 */

export const all = (userId: string): Record<string, string> =>
    Object.fromEntries(
        (
            db.prepare(`SELECT "key", "value" FROM "UserPref" WHERE "userId" = ?`).all(userId) as {
                key: string;
                value: string;
            }[]
        ).map((row) => [row.key, row.value])
    );

/**
 * Applies a patch in one transaction.
 *
 * A null value deletes the key rather than storing "null", so a preference can be returned to
 * its default instead of being pinned to whatever the default happened to be when it was
 * cleared.
 *
 * The statements are prepared here rather than at module scope, as every other repo does.
 * `db` is a lazy proxy that opens the connection on first use, and better-sqlite3 validates
 * SQL against the live schema at *prepare* time — so a top-level `db.prepare` opens the
 * database and checks for the table as a side effect of importing this file. That is fine
 * wherever a migrated database already exists, and fatal where one does not: `next build`
 * imports every route module to read its config, so the container image build died on
 * `no such table: UserPref` while collecting page data for a route that merely reaches this
 * repo through its import graph.
 */
export const setMany = (userId: string, patch: Record<string, string | null>): void => {
    const upsert = db.prepare(
        `INSERT INTO "UserPref" ("userId", "key", "value", "updatedAt")
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("userId", "key") DO UPDATE
            SET "value" = excluded."value", "updatedAt" = CURRENT_TIMESTAMP`
    );

    const del = db.prepare(`DELETE FROM "UserPref" WHERE "userId" = ? AND "key" = ?`);

    db.transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
                del.run(userId, key);
            } else {
                upsert.run(userId, key, value);
            }
        }
    })();
};
