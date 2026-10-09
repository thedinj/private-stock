import { randomUUID } from "node:crypto";

import type { ClipQuery, UpdateClipInput } from "@private-stock/core";

import { db } from "../db.js";
import { notHiddenSql } from "./hiddenSql.js";
import { allTagsSql, anyTagSql } from "./tagSql.js";

/**
 * Clips: spans of an item, marked by one person (§14d).
 *
 * **Private raw material.** Unlike a capture (§9), a clip is not library-wide to read: it is a
 * working note about where something happens and most are never used, so every read here that
 * serves a list takes a `userId` and filters on it. The one that does not is `listByIds`, which
 * assembles a reel — there the reel has already granted the read, and the clips it names may
 * belong to somebody the viewer is not.
 *
 * Ordering is **by position in the video, never by when a clip was made**, wherever an item's
 * own clips are listed. That is §9's rule for the frame strip and it holds for the same reason:
 * scanning the strip is scanning forward through the item, and sorting by creation shunts
 * everything along by one every time somebody marks another.
 */

export interface ClipRow {
    id: string;
    mediaId: string;
    /** Null once the account that marked it is gone. See `mayAlterOwnWork`. */
    userId: string | null;
    startMs: number;
    endMs: number;
    label: string | null;
    /** Null means 1.0, and is not the same statement as a stored 1.0. */
    speed: number | null;
    createdAt: string;
    updatedAt: string;
}

export interface ClipSummaryRow extends ClipRow {
    mediaTitle: string | null;
    mediaRootId: string;
    mediaDurationMs: number | null;
    /** How many reels hold it. By the owner invariant they all belong to `userId`. */
    reelCount: number;
}

export interface NewClipInput {
    mediaId: string;
    userId: string;
    startMs: number;
    endMs: number;
    label: string | null;
    speed: number | null;
}

/**
 * Run time in SQL, and it must agree with `spanRunMs` in core.
 *
 * Not `endMs - startMs`: a span at half speed takes twice as long to watch, and every duration
 * the app reports is the time it takes rather than the stretch of source it covers.
 */
const RUN_MS_SQL = `CAST(ROUND((c."endMs" - c."startMs") / COALESCE(c."speed", 1.0)) AS INTEGER)`;

const SUMMARY_SELECTION = `
    SELECT c.*, m."title" AS "mediaTitle", m."listRootId" AS "mediaRootId",
           m."durationMs" AS "mediaDurationMs",
           (SELECT COUNT(*) FROM "ReelItem" ri WHERE ri."clipId" = c."id") AS "reelCount"
      FROM "Clip" c
      JOIN "Media" m ON m."id" = c."mediaId"
`;

export const create = (input: NewClipInput): string => {
    const id = randomUUID();

    db.prepare(
        `INSERT INTO "Clip"
             ("id", "mediaId", "userId", "startMs", "endMs", "label", "speed", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, input.mediaId, input.userId, input.startMs, input.endMs, input.label, input.speed);

    return id;
};

export const findById = (id: string): ClipRow | undefined =>
    db.prepare(`SELECT * FROM "Clip" WHERE "id" = ?`).get(id) as ClipRow | undefined;

export const findSummary = (id: string): ClipSummaryRow | undefined =>
    db.prepare(`${SUMMARY_SELECTION} WHERE c."id" = ?`).get(id) as ClipSummaryRow | undefined;

/**
 * One item's clips, for the strip under the player — **this viewer's only**.
 *
 * The `userId` is a query parameter rather than a filter applied afterwards, so a caller cannot
 * read somebody else's spans and then forget to compare. `savedFilterRepo` takes the same care
 * and for the same reason.
 */
export const listForMedia = (mediaId: string, userId: string): ClipSummaryRow[] =>
    db
        .prepare(
            `${SUMMARY_SELECTION}
              WHERE c."mediaId" = :mediaId AND c."userId" = :userId
              ORDER BY c."startMs" ASC, c."endMs" ASC, c."createdAt" ASC`
        )
        .all({ mediaId, userId }) as ClipSummaryRow[];

/**
 * Clips by id, in the order asked for, **without a viewer filter**.
 *
 * The one read here that crosses accounts, and the reel is what permits it: `reelService` has
 * already decided the viewer may open the reel, and a reel's spans are the reel. One statement
 * rather than one per entry, because a reel is read whole.
 */
export const listByIds = (ids: string[]): ClipSummaryRow[] => {
    if (ids.length === 0) {
        return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
        .prepare(`${SUMMARY_SELECTION} WHERE c."id" IN (${placeholders})`)
        .all(...ids) as ClipSummaryRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids.map((id) => byId.get(id)).filter((row): row is ClipSummaryRow => row !== undefined);
};

/** Labels this person has used before, so the name field can suggest rather than ask. */
export const distinctLabels = (userId: string, limit = 200): string[] =>
    db
        .prepare(
            `SELECT DISTINCT "label" FROM "Clip"
              WHERE "userId" = ? AND "label" IS NOT NULL AND "label" <> ''
              ORDER BY "label" COLLATE NOCASE ASC
              LIMIT ?`
        )
        .all(userId, limit)
        .map((row) => (row as { label: string }).label);

const SORT_COLUMNS: Record<ClipQuery["sort"], string> = {
    created: `c."createdAt"`,
    startMs: `c."startMs"`,
    duration: RUN_MS_SQL,
    label: `c."label" COLLATE NOCASE`,
};

/**
 * Binds a list of tag ids as named parameters and returns their placeholders.
 *
 * Named rather than positional because `buildSearch` mixes them with every other filter's names.
 */
const bindIds = (ids: string[], prefix: string, params: Record<string, unknown>): string[] =>
    ids.map((id, index) => {
        params[`${prefix}${index}`] = id;

        return `:${prefix}${index}`;
    });

/** Whether this clip's video carries the tag, in a system the viewer can see. */
const videoHasSql = (placeholder: string): string => anyTagSql([placeholder], `c."mediaId"`);

/** Whether the clip itself carries the tag. */
const clipHasSql = (placeholder: string): string =>
    `EXISTS (SELECT 1 FROM "ClipTag" ct WHERE ct."clipId" = c."id" AND ct."tagId" = ${placeholder})`;

/**
 * The two tag fields of /clips (§14d "Tagging clips"), as clauses to AND with the rest.
 *
 * "Video has" is the library's own tag filter pointed at the clip's video, through the same
 * fragments. "Clip has" asks `ClipTag`, one EXISTS per tag -- deliberate at the few hundred clips
 * one person keeps, and it is what lets a single pick widen to "or its video" without the
 * GROUP BY trick that "all of" uses for items.
 */
const tagClauses = (query: ClipQuery, params: Record<string, unknown>): string[] => {
    const clauses: string[] = [];

    if (query.videoTags?.length) {
        const placeholders = bindIds(query.videoTags, "vt", params);

        if (query.videoMatch === "any") {
            clauses.push(anyTagSql(placeholders, `c."mediaId"`));
        } else {
            params.vtCount = new Set(query.videoTags).size;
            clauses.push(allTagsSql(placeholders, "vtCount", `c."mediaId"`));
        }
    }

    if (query.videoNotTags?.length) {
        clauses.push(`NOT ${anyTagSql(bindIds(query.videoNotTags, "vnt", params), `c."mediaId"`)}`);
    }

    const orVideo = new Set(query.orVideo ?? []);
    /** One clip-side pick, widened to its video where the person asked for that. */
    const clipPick = (id: string, placeholder: string): string =>
        orVideo.has(id)
            ? `(${clipHasSql(placeholder)} OR ${videoHasSql(placeholder)})`
            : clipHasSql(placeholder);

    if (query.clipTags?.length) {
        const placeholders = bindIds(query.clipTags, "ct", params);
        const picks = query.clipTags.map((id, index) => clipPick(id, placeholders[index]));

        clauses.push(`(${picks.join(query.clipMatch === "any" ? " OR " : " AND ")})`);
    }

    if (query.clipNotTags?.length) {
        // "Without, or its video" means neither the clip nor its video carries it.
        const placeholders = bindIds(query.clipNotTags, "cnt", params);

        query.clipNotTags.forEach((id, index) => {
            clauses.push(`NOT ${clipPick(id, placeholders[index])}`);
        });
    }

    return clauses;
};

interface SearchScope {
    userId: string;
    accessibleRootIds: string[] | null;
}

/**
 * The clip browser's query. Always this viewer's own clips, plus the library's own access rule.
 *
 * Two filters, not one: `userId` because clips are private, and `accessibleRootIds` because the
 * item behind a clip may sit in a library this account has lost access to since marking it.
 */
const buildSearch = (
    query: ClipQuery,
    scope: SearchScope
): { where: string; params: Record<string, unknown> } => {
    // `listable` hides clips of an item in the trash until it is restored (§10), as the
    // library and the Captures page do. The clip rows survive either way.
    const clauses = [`c."userId" = :userId`, `m."listable" = 1`];
    const params: Record<string, unknown> = { userId: scope.userId };

    if (scope.accessibleRootIds !== null) {
        if (scope.accessibleRootIds.length === 0) {
            return { where: "WHERE 1 = 0", params };
        }

        const names = scope.accessibleRootIds.map((_, index) => `:root${index}`);

        scope.accessibleRootIds.forEach((rootId, index) => {
            params[`root${index}`] = rootId;
        });
        clauses.push(`m."listRootId" IN (${names.join(", ")})`);
    }

    if (query.mediaId) {
        clauses.push(`c."mediaId" = :mediaId`);
        params.mediaId = query.mediaId;
    } else {
        // Browsing, not standing on one item: an item this person has hidden does not come back
        // through its clips (§6). Asked for by id — the clip bar on that item's own page — the
        // item has been opened on purpose, and its clips are shown.
        clauses.push(notHiddenSql(`c."mediaId"`));
    }

    if (query.rootId) {
        clauses.push(`m."listRootId" = :rootId`);
        params.rootId = query.rootId;
    }

    if (query.search) {
        clauses.push(`c."label" LIKE :search ESCAPE '\\'`);
        params.search = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
    }

    if (query.unusedOnly) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM "ReelItem" ri WHERE ri."clipId" = c."id")`);
    }

    clauses.push(...tagClauses(query, params));

    if (query.minDurationMs !== undefined) {
        clauses.push(`${RUN_MS_SQL} >= :minDurationMs`);
        params.minDurationMs = query.minDurationMs;
    }

    if (query.maxDurationMs !== undefined) {
        clauses.push(`${RUN_MS_SQL} <= :maxDurationMs`);
        params.maxDurationMs = query.maxDurationMs;
    }

    return { where: `WHERE ${clauses.join(" AND ")}`, params };
};

export const search = (
    query: ClipQuery,
    scope: SearchScope,
    direction: "asc" | "desc"
): ClipSummaryRow[] => {
    const { where, params } = buildSearch(query, scope);
    const order = direction === "asc" ? "ASC" : "DESC";

    return db
        .prepare(
            `${SUMMARY_SELECTION} ${where}
              ORDER BY ${SORT_COLUMNS[query.sort]} ${order}, c."id" ASC
              LIMIT :limit OFFSET :offset`
        )
        .all({
            ...params,
            limit: query.limit,
            offset: query.page * query.limit,
        }) as ClipSummaryRow[];
};

export const countSearch = (query: ClipQuery, scope: SearchScope): number => {
    const { where, params } = buildSearch(query, scope);

    return (
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM "Clip" c JOIN "Media" m ON m."id" = c."mediaId" ${where}`
            )
            .get(params) as { n: number }
    ).n;
};

export const update = (id: string, input: UpdateClipInput): void => {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.startMs !== undefined) {
        sets.push(`"startMs" = ?`);
        params.push(input.startMs);
    }

    if (input.endMs !== undefined) {
        sets.push(`"endMs" = ?`);
        params.push(input.endMs);
    }

    if (input.label !== undefined) {
        sets.push(`"label" = ?`);
        params.push(input.label);
    }

    // `null` clears the speed back to normal rate; `undefined` leaves it alone. Two different
    // intentions, and the patch has to be able to say both.
    if (input.speed !== undefined) {
        sets.push(`"speed" = ?`);
        params.push(input.speed);
    }

    if (sets.length === 0) {
        return;
    }

    sets.push(`"updatedAt" = CURRENT_TIMESTAMP`);
    db.prepare(`UPDATE "Clip" SET ${sets.join(", ")} WHERE "id" = ?`).run(...params, id);
};

export const remove = (id: string): void => {
    db.prepare(`DELETE FROM "Clip" WHERE "id" = ?`).run(id);
};

/**
 * The reels holding this clip.
 *
 * No viewer parameter, and that absence is the owner invariant showing through: a reel holds
 * nothing but its owner's clips (§14d), so every reel here belongs to the clip's own author and
 * there is no half of the answer to withhold. That is what lets a retime say "this is in
 * Florida 2026 and Best of the year" rather than "this is in 3 reels, 1 of which you cannot
 * see".
 */
export const reelsUsing = (clipId: string): { id: string; name: string }[] =>
    db
        .prepare(
            `SELECT DISTINCT r."id", r."name"
               FROM "ReelItem" ri
               JOIN "Reel" r ON r."id" = ri."reelId"
              WHERE ri."clipId" = ?
              ORDER BY r."name" COLLATE NOCASE ASC`
        )
        .all(clipId) as { id: string; name: string }[];

/** How many clips an item carries for one person, for the item page's heading. */
export const countForMedia = (mediaId: string, userId: string): number =>
    (
        db
            .prepare(`SELECT COUNT(*) AS n FROM "Clip" WHERE "mediaId" = ? AND "userId" = ?`)
            .get(mediaId, userId) as { n: number }
    ).n;
