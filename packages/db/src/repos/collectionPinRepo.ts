import type { CollectionKind } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Where one person wants one collection in their own sidebar (§14b).
 *
 * A "collection" is either kind of thing that exposes a subset of the library: a saved view,
 * which is a query, or a playlist, which is a list. Everything about who may see one and where
 * it sits is deliberately the same for both, and this table is the part that could not be.
 *
 * The pin columns on `Playlist` and `SavedFilter` belong to the owner. On a **shared**
 * collection the owner is an administrator, so their pin is the household's default — the
 * baseline a new account arrives to. This table is how anybody else disagrees with it.
 *
 * **The absence of a row is a state.** No row means "no opinion, follow the default"; a row
 * with `pinned = 1` means "in my sidebar"; a row with `pinned` NULL means "I took it out".
 * So the row says *that* somebody decided and the column says *what* — which is why a NULL
 * here is not the same as no row, unlike everywhere else in the schema.
 */

export interface CollectionPinRow {
    userId: string;
    kind: CollectionKind;
    collectionId: string;
    pinned: 1 | null;
    position: number | null;
}

/**
 * Record, or clear, one person's opinion about one collection.
 *
 * `null` deletes the row rather than storing a third value, which is what puts the collection
 * back on the household default. That is a real gesture and not just an undo: "show me
 * whatever the house shows" is different from "do not show me this".
 */
export const setPin = (
    userId: string,
    kind: CollectionKind,
    collectionId: string,
    pinned: boolean | null
): void => {
    if (pinned === null) {
        db.prepare(
            `DELETE FROM "CollectionPin"
              WHERE "userId" = ? AND "kind" = ? AND "collectionId" = ?`
        ).run(userId, kind, collectionId);

        return;
    }

    db.prepare(
        `INSERT INTO "CollectionPin" ("userId", "kind", "collectionId", "pinned", "updatedAt")
         VALUES (:userId, :kind, :collectionId, :pinned, CURRENT_TIMESTAMP)
         ON CONFLICT ("userId", "kind", "collectionId")
             DO UPDATE SET "pinned" = :pinned, "updatedAt" = CURRENT_TIMESTAMP`
    ).run({ userId, kind, collectionId, pinned: pinned ? 1 : null });
};

export const findPin = (
    userId: string,
    kind: CollectionKind,
    collectionId: string
): CollectionPinRow | undefined =>
    db
        .prepare(
            `SELECT * FROM "CollectionPin"
              WHERE "userId" = ? AND "kind" = ? AND "collectionId" = ?`
        )
        .get(userId, kind, collectionId) as CollectionPinRow | undefined;

/**
 * Where this person put the collections of one kind, as a lookup.
 *
 * Read in one statement and resolved in the service rather than joined into each listing
 * query. The two listing queries are already the most intricate SQL in their repos, and a
 * three-state override expressed as `CASE WHEN … IS NULL` over a LEFT JOIN is the kind of
 * expression that is read wrongly once and then trusted.
 */
export const pinsFor = (userId: string, kind: CollectionKind): Map<string, CollectionPinRow> =>
    new Map(
        (
            db
                .prepare(`SELECT * FROM "CollectionPin" WHERE "userId" = ? AND "kind" = ?`)
                .all(userId, kind) as CollectionPinRow[]
        ).map((row) => [row.collectionId, row])
    );

/**
 * Forget every opinion about one collection, for everybody.
 *
 * Called when a collection is deleted. The rows would otherwise be orphans — harmless, since
 * every read starts from a collection that no longer exists, but they are somebody's data and
 * nothing else would ever remove them.
 */
export const clearPinsFor = (kind: CollectionKind, collectionId: string): void => {
    db.prepare(`DELETE FROM "CollectionPin" WHERE "kind" = ? AND "collectionId" = ?`).run(
        kind,
        collectionId
    );
};
