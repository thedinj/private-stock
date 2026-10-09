import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * A named library query, belonging to one user (§6).
 *
 * Shareable read-only, exactly as a playlist is, and for the same reason: the query is re-run
 * as whoever is looking, so each viewer sees their own accessible libraries and nothing else.
 * What sharing a filter can do that sharing a playlist cannot is name a different set of items
 * for each viewer — see `isViewerRelative` in the schema for why that is surfaced rather than
 * forbidden.
 *
 * The query is stored as JSON rather than as columns. It is the grid's own query object, and
 * decomposing it into columns would mean a schema change every time the filter panel learned
 * a new field — for a value nothing ever queries *by*.
 */

export interface SavedFilterRow {
    id: string;
    userId: string;
    name: string;
    queryJson: string;
    description: string | null;
    visibility: "private" | "shared";
    resolveAs: "viewer" | "owner";
    pinned: 1 | null;
    position: number;
    createdAt: string;
    updatedAt: string;
}

export interface SavedFilterSummaryRow extends SavedFilterRow {
    ownerName: string;
}

const SUMMARY_SELECTION = `
    SELECT f.*, u."displayName" AS "ownerName"
      FROM "SavedFilter" f
      JOIN "User" u ON u."id" = f."userId"
`;

export interface NewSavedFilterInput {
    userId: string;
    name: string;
    queryJson: string;
    description: string | null;
    pinned: boolean;
    visibility: "private" | "shared";
    resolveAs: "viewer" | "owner";
}

export const create = (input: NewSavedFilterInput): string => {
    const id = randomUUID();

    const next = db
        .prepare(
            `SELECT COALESCE(MAX("position"), -1) + 1 AS n FROM "SavedFilter" WHERE "userId" = ?`
        )
        .get(input.userId) as { n: number };

    db.prepare(
        `INSERT INTO "SavedFilter"
             ("id", "userId", "name", "queryJson", "description", "visibility", "resolveAs",
              "pinned", "position", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
        id,
        input.userId,
        input.name,
        input.queryJson,
        input.description,
        input.visibility,
        input.resolveAs,
        // 1 or NULL, never 0 — the column's CHECK and the conventions both require it.
        input.pinned ? 1 : null,
        next.n
    );

    return id;
};

/**
 * One filter, scoped to its owner.
 *
 * `userId` is a parameter rather than something checked afterwards, so a caller cannot
 * accidentally read another account's filter and then forget to compare the owner. This is
 * the lookup for *writes*; reads go through `findVisibleTo`, which also admits shared ones.
 */
export const findById = (id: string, userId: string): SavedFilterRow | undefined =>
    db.prepare(`SELECT * FROM "SavedFilter" WHERE "id" = ? AND "userId" = ?`).get(id, userId) as
        SavedFilterRow | undefined;

/** One filter this user may read: their own, or anyone's shared one. */
export const findVisibleTo = (id: string, userId: string): SavedFilterSummaryRow | undefined =>
    db
        .prepare(
            `${SUMMARY_SELECTION}
              WHERE f."id" = :id AND (f."userId" = :userId OR f."visibility" = 'shared')`
        )
        .get({ id, userId }) as SavedFilterSummaryRow | undefined;

export const findByName = (userId: string, name: string): SavedFilterRow | undefined =>
    db
        .prepare(`SELECT * FROM "SavedFilter" WHERE "userId" = ? AND "name" = ?`)
        .get(userId, name) as SavedFilterRow | undefined;

/**
 * What this user can open: their own, plus everything anyone has shared.
 *
 * Own first, then pinned, then the order they arranged. Someone else's pin and position are
 * their arrangement of their own sidebar and mean nothing here, so shared filters from other
 * accounts fall to the end and sort by name.
 */
export const listVisibleTo = (userId: string): SavedFilterSummaryRow[] =>
    db
        .prepare(
            `${SUMMARY_SELECTION}
              WHERE f."userId" = :userId OR f."visibility" = 'shared'
              ORDER BY (f."userId" = :userId) DESC,
                       (f."userId" = :userId AND f."pinned" IS NOT NULL) DESC,
                       CASE WHEN f."userId" = :userId THEN f."position" ELSE 0 END ASC,
                       f."name" COLLATE NOCASE ASC`
        )
        .all({ userId }) as SavedFilterSummaryRow[];

export interface UpdateSavedFilterFields {
    name?: string;
    queryJson?: string;
    description?: string | null;
    pinned?: boolean;
    position?: number;
    visibility?: "private" | "shared";
    resolveAs?: "viewer" | "owner";
}

export const update = (id: string, userId: string, input: UpdateSavedFilterFields): boolean => {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
        sets.push(`"name" = ?`);
        params.push(input.name);
    }

    if (input.queryJson !== undefined) {
        sets.push(`"queryJson" = ?`);
        params.push(input.queryJson);
    }

    if (input.description !== undefined) {
        sets.push(`"description" = ?`);
        params.push(input.description);
    }

    if (input.visibility !== undefined) {
        sets.push(`"visibility" = ?`);
        params.push(input.visibility);
    }

    if (input.resolveAs !== undefined) {
        sets.push(`"resolveAs" = ?`);
        params.push(input.resolveAs);
    }

    if (input.pinned !== undefined) {
        sets.push(`"pinned" = ?`);
        params.push(input.pinned ? 1 : null);
    }

    if (input.position !== undefined) {
        sets.push(`"position" = ?`);
        params.push(input.position);
    }

    if (sets.length === 0) {
        return false;
    }

    return (
        db
            .prepare(
                `UPDATE "SavedFilter" SET ${sets.join(", ")}, "updatedAt" = CURRENT_TIMESTAMP
                  WHERE "id" = ? AND "userId" = ?`
            )
            .run(...params, id, userId).changes > 0
    );
};

export const remove = (id: string, userId: string): boolean =>
    db.prepare(`DELETE FROM "SavedFilter" WHERE "id" = ? AND "userId" = ?`).run(id, userId)
        .changes > 0;
