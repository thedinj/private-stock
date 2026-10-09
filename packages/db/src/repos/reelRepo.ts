import { randomUUID } from "node:crypto";

import type { ReelQuery, UpdateReelInput } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Reels: ordered arrangements of spans (§14d).
 *
 * Shaped after `playlistRepo`, which is the house's reference for an owned, ordered, densely
 * positioned collection — and deliberately different from it in three places, each marked below:
 *
 *  - **A duplicate is allowed.** A refrain is a legitimate cut, so there is no `DO NOTHING` on
 *    insert and `removeItem` takes a `ReelItem.id` rather than a clip id: a clip id may name two
 *    rows, or none.
 *  - **Only the owner's clips go in.** `addItems` filters on it in SQL as well as the service
 *    checking it, so the invariant survives a second caller arriving later.
 *  - **Duration is run time, not span length.** A span at half speed takes twice as long to
 *    watch, so `RUN_MS_SQL` divides by the speed and must agree with `spanRunMs` in core.
 *
 * Positions are dense, and stay dense. Nothing here permutes them — a reel does not shuffle —
 * but "3 of 12" and `moveItem`'s renumbering both rest on it, and `purge` has to repair it after
 * a cascade removes a span from the middle (§10c).
 */

export interface ReelRow {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    visibility: "private" | "shared";
    createdAt: string;
    updatedAt: string;
}

export interface ReelSummaryRow extends ReelRow {
    /** Spans in it, including any whose item the viewer cannot currently reach. */
    itemCount: number;
    /** Sum of the spans' run times. See `RUN_MS_SQL`. */
    runningMs: number;
    ownerName: string;
}

export interface ReelEntryRow {
    /** `ReelItem.id`. What remove and move name. */
    id: string;
    position: number;
    clipId: string;
    mediaId: string;
}

export interface NewReelInput {
    ownerId: string;
    name: string;
    description: string | null;
    visibility: "private" | "shared";
}

/** Must agree with `spanRunMs` in `@private-stock/core`. */
const RUN_MS_SQL = `CAST(ROUND((c."endMs" - c."startMs") / COALESCE(c."speed", 1.0)) AS INTEGER)`;

const AGGREGATES = `
    (SELECT COUNT(*) FROM "ReelItem" ri WHERE ri."reelId" = r."id") AS "itemCount",
    (SELECT COALESCE(SUM(${RUN_MS_SQL}), 0)
       FROM "ReelItem" ri JOIN "Clip" c ON c."id" = ri."clipId"
      WHERE ri."reelId" = r."id") AS "runningMs"
`;

const SUMMARY_SELECTION = `
    SELECT r.*, u."displayName" AS "ownerName", ${AGGREGATES}
      FROM "Reel" r
      JOIN "User" u ON u."id" = r."ownerId"
`;

export const create = (input: NewReelInput): string => {
    const id = randomUUID();

    db.prepare(
        `INSERT INTO "Reel"
             ("id", "ownerId", "name", "description", "visibility", "updatedAt")
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, input.ownerId, input.name, input.description, input.visibility);

    return id;
};

export const findById = (id: string): ReelRow | undefined =>
    db.prepare(`SELECT * FROM "Reel" WHERE "id" = ?`).get(id) as ReelRow | undefined;

export const findSummary = (id: string): ReelSummaryRow | undefined =>
    db.prepare(`${SUMMARY_SELECTION} WHERE r."id" = ?`).get(id) as ReelSummaryRow | undefined;

export const findByName = (ownerId: string, name: string): ReelRow | undefined =>
    db.prepare(`SELECT * FROM "Reel" WHERE "ownerId" = ? AND "name" = ?`).get(ownerId, name) as
        ReelRow | undefined;

const SORT_COLUMNS: Record<ReelQuery["sort"], string> = {
    updated: `r."updatedAt"`,
    created: `r."createdAt"`,
    name: `r."name" COLLATE NOCASE`,
    duration: `"runningMs"`,
    clipCount: `"itemCount"`,
};

/**
 * The index's filter. One ownership axis rather than two stacked walls.
 *
 * §14c's Collections page shows "yours" and then "the household's" as two sections, which works
 * because there are a handful of each. Reels are numerous enough that a screenful of one section
 * hides the other entirely, so ownership is a control here and not a layout.
 */
const buildVisible = (
    query: ReelQuery,
    userId: string
): { where: string; params: Record<string, unknown> } => {
    const params: Record<string, unknown> = { userId };
    const clauses: string[] = [];

    if (query.ownership === "mine") {
        clauses.push(`r."ownerId" = :userId`);
    } else if (query.ownership === "shared") {
        clauses.push(`r."visibility" = 'shared' AND r."ownerId" <> :userId`);
    } else {
        clauses.push(`(r."ownerId" = :userId OR r."visibility" = 'shared')`);
    }

    if (query.search) {
        clauses.push(
            `(r."name" LIKE :search ESCAPE '\\' OR r."description" LIKE :search ESCAPE '\\')`
        );
        params.search = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
    }

    return { where: `WHERE ${clauses.join(" AND ")}`, params };
};

export const listVisibleTo = (
    query: ReelQuery,
    userId: string,
    direction: "asc" | "desc"
): ReelSummaryRow[] => {
    const { where, params } = buildVisible(query, userId);
    const order = direction === "asc" ? "ASC" : "DESC";

    return db
        .prepare(
            `${SUMMARY_SELECTION} ${where}
              ORDER BY ${SORT_COLUMNS[query.sort]} ${order}, r."id" ASC
              LIMIT :limit OFFSET :offset`
        )
        .all({
            ...params,
            limit: query.limit,
            offset: query.page * query.limit,
        }) as ReelSummaryRow[];
};

export const countVisibleTo = (query: ReelQuery, userId: string): number => {
    const { where, params } = buildVisible(query, userId);

    return (db.prepare(`SELECT COUNT(*) AS n FROM "Reel" r ${where}`).get(params) as { n: number })
        .n;
};

export const update = (id: string, input: UpdateReelInput): void => {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
        sets.push(`"name" = ?`);
        params.push(input.name);
    }

    if (input.description !== undefined) {
        sets.push(`"description" = ?`);
        params.push(input.description);
    }

    if (input.visibility !== undefined) {
        sets.push(`"visibility" = ?`);
        params.push(input.visibility);
    }

    if (sets.length === 0) {
        return;
    }

    sets.push(`"updatedAt" = CURRENT_TIMESTAMP`);
    db.prepare(`UPDATE "Reel" SET ${sets.join(", ")} WHERE "id" = ?`).run(...params, id);
};

/**
 * Marks the reel as changed.
 *
 * Membership is the reel's content — more so than a playlist's, since the sequence is the work —
 * so adding, removing or moving a span is an edit to it. Without this, "recently updated", which
 * is the index's default order, would only ever reflect renames.
 */
const touch = (reelId: string): void => {
    db.prepare(`UPDATE "Reel" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(reelId);
};

/** Items cascade; the clips themselves are untouched, being the owner's raw material. */
export const remove = (id: string): void => {
    db.prepare(`DELETE FROM "Reel" WHERE "id" = ?`).run(id);
};

export const listEntries = (reelId: string): ReelEntryRow[] =>
    db
        .prepare(
            `SELECT ri."id", ri."position", ri."clipId", c."mediaId"
               FROM "ReelItem" ri
               JOIN "Clip" c ON c."id" = ri."clipId"
              WHERE ri."reelId" = ?
              ORDER BY ri."position" ASC`
        )
        .all(reelId) as ReelEntryRow[];

export const countItems = (reelId: string): number =>
    (
        db.prepare(`SELECT COUNT(*) AS n FROM "ReelItem" WHERE "reelId" = ?`).get(reelId) as {
            n: number;
        }
    ).n;

export const runningMs = (reelId: string): number =>
    (
        db
            .prepare(
                `SELECT COALESCE(SUM(${RUN_MS_SQL}), 0) AS n
                   FROM "ReelItem" ri JOIN "Clip" c ON c."id" = ri."clipId"
                  WHERE ri."reelId" = ?`
            )
            .get(reelId) as { n: number }
    ).n;

/**
 * A few media ids from across the reel, for the card's mosaic.
 *
 * Spread evenly rather than taken off the top, so the card is a glimpse of the reel and not of
 * its opening shot — the same reasoning, and the same shape, as `playlistRepo.sampleItemIds`.
 */
export const sampleMediaIds = (reelId: string, count: number): string[] => {
    const total = countItems(reelId);

    if (total === 0 || count <= 0) {
        return [];
    }

    const wanted = Math.min(count, total);
    const seen = new Set<number>();
    const positions: number[] = [];

    for (let index = 0; index < wanted; index += 1) {
        const position = Math.floor((index * total) / wanted);

        if (!seen.has(position)) {
            seen.add(position);
            positions.push(position);
        }
    }

    const placeholders = positions.map(() => "?").join(", ");

    return db
        .prepare(
            `SELECT c."mediaId"
               FROM "ReelItem" ri JOIN "Clip" c ON c."id" = ri."clipId"
              WHERE ri."reelId" = ? AND ri."position" IN (${placeholders})
              ORDER BY ri."position" ASC`
        )
        .all(reelId, ...positions)
        .map((row) => (row as { mediaId: string }).mediaId);
};

/**
 * Appends spans, and refuses any that are not the owner's.
 *
 * **No `ON CONFLICT DO NOTHING`**, unlike `playlistRepo.addItems`. A playlist holding the same
 * item twice would play it twice for no reason anybody intended; a reel holding the same span
 * twice is a refrain, which is a thing people cut deliberately.
 *
 * The `WHERE` on the insert is the owner invariant (§14d) stated where the write happens.
 * `reelService` checks it too and raises a useful error; this is the half that holds if another
 * write path is ever added without going through the service. Returns how many went in, so the
 * service can tell a partial acceptance from a whole one.
 */
export const addItems = (reelId: string, ownerId: string, clipIds: string[]): number => {
    if (clipIds.length === 0) {
        return 0;
    }

    return db.transaction((): number => {
        const next = db
            .prepare(
                `SELECT COALESCE(MAX("position"), -1) + 1 AS n FROM "ReelItem" WHERE "reelId" = ?`
            )
            .get(reelId) as { n: number };

        const insert = db.prepare(
            `INSERT INTO "ReelItem" ("id", "reelId", "clipId", "position")
             SELECT ?, ?, c."id", ?
               FROM "Clip" c
              WHERE c."id" = ? AND c."userId" = ?`
        );

        let position = next.n;
        let added = 0;

        for (const clipId of clipIds) {
            if (insert.run(randomUUID(), reelId, position, clipId, ownerId).changes > 0) {
                position += 1;
                added += 1;
            }
        }

        if (added > 0) {
            touch(reelId);
        }

        return added;
    })();
};

/**
 * Removes one entry and closes the gap behind it.
 *
 * By `ReelItem.id`, not by clip id: the same clip may sit at two positions, so a clip id names
 * either no row or an ambiguous pair. Only the positions after the removed one move, which is
 * one indexed statement rather than the full renumbering `moveItem` does.
 */
export const removeItem = (reelId: string, itemId: string): boolean =>
    db.transaction((): boolean => {
        const row = db
            .prepare(`SELECT "position" FROM "ReelItem" WHERE "reelId" = ? AND "id" = ?`)
            .get(reelId, itemId) as { position: number } | undefined;

        if (row === undefined) {
            return false;
        }

        db.prepare(`DELETE FROM "ReelItem" WHERE "id" = ?`).run(itemId);
        db.prepare(
            `UPDATE "ReelItem" SET "position" = "position" - 1
              WHERE "reelId" = ? AND "position" > ?`
        ).run(reelId, row.position);

        touch(reelId);

        return true;
    })();

/**
 * Moves one entry to a given index, renumbering the reel.
 *
 * One item and a destination rather than the whole sequence — that is what a drag is, and it
 * means a client holding a stale copy cannot silently drop entries it never loaded.
 * `REEL_ITEM_LIMIT` bounds the renumbering at two hundred updates.
 */
export const moveItem = (reelId: string, itemId: string, toIndex: number): boolean =>
    db.transaction((): boolean => {
        const ids = listEntries(reelId).map((entry) => entry.id);
        const from = ids.indexOf(itemId);

        if (from < 0) {
            return false;
        }

        ids.splice(from, 1);
        ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, itemId);

        const setPosition = db.prepare(`UPDATE "ReelItem" SET "position" = ? WHERE "id" = ?`);

        ids.forEach((id, index) => setPosition.run(index, id));

        touch(reelId);

        return true;
    })();

/**
 * Closes any holes in a reel's positions.
 *
 * Needed because two paths remove entries **without going through `removeItem`**: purging an
 * item cascades `Media` → `Clip` → `ReelItem` (§10c), and so does forgetting a library. Both
 * take rows out of the middle of somebody's reel, and a hole makes "3 of 12" a number that can
 * exceed twelve. Callers collect the affected ids with `reelIdsHoldingMedia` **before** the
 * delete, because afterwards there is nothing left to join through.
 */
export const renumber = (reelId: string): void => {
    db.transaction((): void => {
        const ids = db
            .prepare(`SELECT "id" FROM "ReelItem" WHERE "reelId" = ? ORDER BY "position" ASC`)
            .all(reelId)
            .map((row) => (row as { id: string }).id);

        const setPosition = db.prepare(`UPDATE "ReelItem" SET "position" = ? WHERE "id" = ?`);

        ids.forEach((id, index) => setPosition.run(index, id));
    })();
};

/** Reels holding any span of this item. Collected before a delete, while the join still holds. */
export const reelIdsHoldingMedia = (mediaId: string): string[] =>
    db
        .prepare(
            `SELECT DISTINCT ri."reelId"
               FROM "ReelItem" ri JOIN "Clip" c ON c."id" = ri."clipId"
              WHERE c."mediaId" = ?`
        )
        .all(mediaId)
        .map((row) => (row as { reelId: string }).reelId);

/**
 * Closes the holes left in every reel that has one, and says how many it repaired.
 *
 * The general repair, for the cascades that cannot say in advance which reels they will shorten
 * — forgetting a library deletes every orphaned item in one statement, so there is no single
 * media id to collect against. Called *after* the delete, because a hole is the only evidence
 * left once the clip is gone.
 *
 * A reel is gapped when its highest position is not one less than its length. That cannot see a
 * duplicated position, which no writer here can produce: `addItems` appends past the maximum,
 * `moveItem` renumbers from zero, and `removeItem` only ever shifts down.
 */
export const renumberGapped = (): number => {
    const gapped = db
        .prepare(
            `SELECT "reelId" FROM "ReelItem"
              GROUP BY "reelId"
             HAVING MAX("position") <> COUNT(*) - 1`
        )
        .all()
        .map((row) => (row as { reelId: string }).reelId);

    gapped.forEach((reelId) => renumber(reelId));

    return gapped.length;
};

/**
 * How many spans of this item sit in reels, and whose, for the delete confirmation (§10c).
 *
 * `mine` can be named; the rest is a bare count. Eliminating a near-duplicate destroys the clips
 * on the copy that goes — §10c deliberately does not merge them, because a near duplicate is a
 * different encode and a timecode moved onto it would point at the wrong frames — so the
 * reviewer has to be told, and a merge nobody was told about is indistinguishable from a loss.
 */
export const clipsAtRiskFor = (
    mediaId: string,
    userId: string
): { mine: number; total: number; reels: { id: string; name: string }[] } => {
    const counts = db
        .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN "userId" = ? THEN 1 ELSE 0 END) AS mine
               FROM "Clip" WHERE "mediaId" = ?`
        )
        .get(userId, mediaId) as { total: number; mine: number | null };

    const reels = db
        .prepare(
            `SELECT DISTINCT r."id", r."name"
               FROM "ReelItem" ri
               JOIN "Clip" c ON c."id" = ri."clipId"
               JOIN "Reel" r ON r."id" = ri."reelId"
              WHERE c."mediaId" = ? AND r."ownerId" = ?
              ORDER BY r."name" COLLATE NOCASE ASC`
        )
        .all(mediaId, userId) as { id: string; name: string }[];

    return { mine: counts.mine ?? 0, total: counts.total, reels };
};
