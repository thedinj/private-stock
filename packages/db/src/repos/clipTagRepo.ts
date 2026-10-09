import { randomUUID } from "node:crypto";

import { isClipTagKind } from "@private-stock/core";

import { db } from "../db.js";
import { pruneUnused } from "./tagRepo.js";

/**
 * Tags on clips (§14d "Tagging clips").
 *
 * The library's vocabulary, assigned to a span. Every assignment is for the clip's owner, so there
 * is no "userId" here; the pairing rule `MediaTag` keeps with its own column is kept here against
 * the clip: a tag with an owner goes only on that owner's clips. Enforced in `assign`, the one
 * write path besides a bulk batch, whose caller checks the same thing.
 */

export interface ClipTagRow {
    clipId: string;
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    position: number | null;
    /** The tag's owner, so the caller can say whether it is the viewer's own. */
    ownerId: string | null;
}

export interface ClipTagFacetRow {
    tagId: string;
    kind: string;
    name: string;
    ownerId: string | null;
    count: number;
}

/**
 * Whether this tag may go on this clip: a clip facet, and either the library's or the owner's.
 *
 * Thrown as a plain error because the services have already said no in words -- reaching this is
 * a bug, not somebody's typing.
 */
export const assertFits = (clipId: string, tagId: string): void => {
    const row = db
        .prepare(
            `SELECT t."kind", t."ownerId", c."userId"
               FROM "Tag" t, "Clip" c
              WHERE t."id" = ? AND c."id" = ?`
        )
        .get(tagId, clipId) as
        { kind: string; ownerId: string | null; userId: string | null } | undefined;

    if (!row) {
        throw new Error(`No such tag or clip: ${tagId}, ${clipId}`);
    }

    if (!isClipTagKind(row.kind)) {
        throw new Error(`A ${row.kind} cannot go on a clip`);
    }

    if (row.ownerId !== null && row.ownerId !== row.userId) {
        throw new Error("A private tag cannot go on anybody's clips but its owner's");
    }
};

export const assign = (input: {
    clipId: string;
    tagId: string;
    position?: number | null;
}): boolean => {
    assertFits(input.clipId, input.tagId);

    return (
        db
            .prepare(
                `INSERT OR IGNORE INTO "ClipTag" ("id", "clipId", "tagId", "position")
                 VALUES (?, ?, ?, ?)`
            )
            .run(randomUUID(), input.clipId, input.tagId, input.position ?? null).changes > 0
    );
};

/**
 * Takes a tag off a clip, and the tag with it if nothing else uses it any more.
 *
 * The same prune as an item's unassign (§14b), so a name mistyped while marking goes away when
 * its chip does.
 */
export const unassign = (clipId: string, tagId: string): number =>
    db.transaction((): number => {
        const removed = db
            .prepare(`DELETE FROM "ClipTag" WHERE "clipId" = ? AND "tagId" = ?`)
            .run(clipId, tagId).changes;

        if (removed > 0) {
            pruneUnused([tagId]);
        }

        return removed;
    })();

/** Where the next tag of a facet goes, so performers keep the order they were typed in. */
export const nextPosition = (clipId: string, kind: string): number =>
    (
        db
            .prepare(
                `SELECT coalesce(max(ct."position"), -1) + 1 AS n
                   FROM "ClipTag" ct JOIN "Tag" t ON t."id" = ct."tagId"
                  WHERE ct."clipId" = ? AND t."kind" = ?`
            )
            .get(clipId, kind) as { n: number }
    ).n;

/** Tags for many clips in one statement, so a page of the browser is not a query per card. */
export const listForClipIds = (clipIds: string[]): Map<string, ClipTagRow[]> => {
    const byClip = new Map<string, ClipTagRow[]>();

    if (clipIds.length === 0) {
        return byClip;
    }

    const rows = db
        .prepare(
            `SELECT ct."clipId", ct."tagId", t."kind", t."name", t."colorKey", ct."position",
                    t."ownerId"
               FROM "ClipTag" ct
               JOIN "Tag" t ON t."id" = ct."tagId"
              WHERE ct."clipId" IN (SELECT value FROM json_each(?))
              ORDER BY t."kind", coalesce(ct."position", 1e9), t."name" COLLATE NOCASE`
        )
        .all(JSON.stringify(clipIds)) as ClipTagRow[];

    for (const row of rows) {
        const list = byClip.get(row.clipId);

        if (list) {
            list.push(row);
        } else {
            byClip.set(row.clipId, [row]);
        }
    }

    return byClip;
};

/** The subset of these ids that are this person's clips. */
export const ownedClipIds = (clipIds: string[], userId: string): string[] =>
    (
        db
            .prepare(
                `SELECT "id" FROM "Clip"
                  WHERE "id" IN (SELECT value FROM json_each(?)) AND "userId" = ?`
            )
            .all(JSON.stringify(clipIds), userId) as { id: string }[]
    ).map((row) => row.id);

/**
 * The chips for /clips: what tags this person's clips carry, and what tags their videos carry.
 *
 * Over the same clips the browser lists -- the viewer's own, of listable items, in libraries they
 * can reach -- and **not** narrowed by the current filter, so a chip keeps its place when another
 * is picked (§5b). The video side counts clips, not videos, because clips are what the page lists.
 */
export const facetsFor = (
    userId: string,
    accessibleRootIds: string[] | null
): { clip: ClipTagFacetRow[]; video: ClipTagFacetRow[] } => {
    if (accessibleRootIds !== null && accessibleRootIds.length === 0) {
        return { clip: [], video: [] };
    }

    const roots =
        accessibleRootIds === null
            ? ""
            : `AND m."listRootId" IN (SELECT value FROM json_each(:roots))`;
    const params = { userId, roots: JSON.stringify(accessibleRootIds ?? []) };
    const mine = `SELECT c."id", c."mediaId" FROM "Clip" c
                    JOIN "Media" m ON m."id" = c."mediaId"
                   WHERE c."userId" = :userId AND m."listable" = 1 ${roots}`;

    const clip = db
        .prepare(
            `SELECT t."id" AS "tagId", t."kind", t."name", t."ownerId",
                    count(DISTINCT ct."clipId") AS "count"
               FROM (${mine}) mc
               JOIN "ClipTag" ct ON ct."clipId" = mc."id"
               JOIN "Tag" t ON t."id" = ct."tagId"
              GROUP BY t."id"
              ORDER BY "count" DESC, t."name" COLLATE NOCASE`
        )
        .all(params) as ClipTagFacetRow[];

    const video = db
        .prepare(
            `SELECT t."id" AS "tagId", t."kind", t."name", t."ownerId",
                    count(DISTINCT mc."id") AS "count"
               FROM (${mine}) mc
               JOIN "MediaTag" mt ON mt."mediaId" = mc."mediaId"
                    -- tagSql's VISIBLE_ASSIGNMENT, aliased: the library's and your own (§6).
                    AND (mt."userId" IS NULL OR mt."userId" = :userId)
               JOIN "Tag" t ON t."id" = mt."tagId"
              GROUP BY t."id"
              ORDER BY "count" DESC, t."name" COLLATE NOCASE`
        )
        .all(params) as ClipTagFacetRow[];

    return { clip, video };
};
