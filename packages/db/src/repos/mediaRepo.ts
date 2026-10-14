import { randomUUID } from "node:crypto";

import {
    groupsArePersonal,
    groupsReadUserMedia,
    mediaKinds,
    naturalDirection,
    searchTerms,
    rowidShuffleParams,
    rulesIn,
    type FilterGroup,
    type FilterMeasure,
    type FilterRule,
    type MediaKind,
    type MediaQuery,
} from "@private-stock/core";

import { db } from "../db.js";
import type { ArtifactKind, ArtifactRow } from "./artifactRepo.js";
import * as mentionRepo from "./mentionRepo.js";
import * as searchRepo from "./searchRepo.js";
import * as tagRepo from "./tagRepo.js";
import { allTagsSql, anyTagSql } from "./tagSql.js";

/**
 * The library query.
 *
 * Two rules from the architecture are enforced structurally here:
 *
 *  - **`userId` is always an explicit parameter** (§6). It is not read from ambient state,
 *    so forgetting it is a type error rather than a privacy leak.
 *  - **Nothing subjective lives on `Media`** — rating, favourite and resume position come
 *    from a LEFT JOIN on `UserMedia`, so a new account sees the whole library with empty
 *    ratings rather than nothing.
 */

export interface MediaListRow {
    id: string;
    kind: "image" | "video";
    title: string | null;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    addedAt: string;
    capturedAt: string | null;
    probedAt: string | null;
    sizeBytes: number | null;
    relPath: string | null;
    coverPath: string | null;
    coverGeneratedAt: string | null;
    previewPath: string | null;
    previewGeneratedAt: string | null;
    /** Set only when a web-safe rendition is complete and playable. */
    websafePath: string | null;
    websafeHeight: number | null;
    /**
     * The probe facts `assessPlayback` reads, so a list row can say whether it plays (§8b).
     *
     * Plain columns on the row already being read -- no join, no second page -- which is what
     * made putting `directPlay` on every tile cheaper than asking for it separately (§14g).
     */
    container: string | null;
    codec: string | null;
    videoProfile: string | null;
    pixFmt: string | null;
    audioCodec: string | null;
    rating: number | null;
    favorite: 1 | null;
    watchedAt: string | null;
}

export interface CreateMediaInput {
    kind: "image" | "video";
    title: string;
    fileId: string;
}

export const createForFile = (input: CreateMediaInput): string => {
    const id = randomUUID();

    db.transaction(() => {
        db.prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(id, input.kind, input.title);

        db.prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES (?, ?, ?, 'original')`
        ).run(randomUUID(), id, input.fileId);
    })();

    return id;
};

export const findMediaIdForFile = (fileId: string): string | undefined => {
    const row = db
        .prepare(`SELECT "mediaId" FROM "MediaFileLink" WHERE "fileId" = ? AND "role" = 'original'`)
        .get(fileId) as { mediaId: string } | undefined;

    return row?.mediaId;
};

/**
 * Follow a renamed or moved file with its title (§12b "A renamed file is the same file").
 *
 * A title is derived from the file's name when the item is created, so after a rename it went on
 * showing the old name for good. Replaced only while it still is the old name's title — a title
 * that says anything else was set deliberately and is left alone. The search document is the
 * caller's to refresh (`searchRepo.requestReindex`), once for the batch.
 */
export const retitleAfterMove = (mediaId: string, fromTitle: string, toTitle: string): boolean =>
    fromTitle !== toTitle &&
    db
        .prepare(
            `UPDATE "Media" SET "title" = ?, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ? AND ("title" = ? OR "title" IS NULL)`
        )
        .run(toTitle, mediaId, fromTitle).changes > 0;

export interface MediaBasicRow {
    id: string;
    kind: "image" | "video";
    durationMs: number | null;
    width: number | null;
    height: number | null;
    probedAt: string | null;
    container: string | null;
    codec: string | null;
    videoProfile: string | null;
    pixFmt: string | null;
    audioCodec: string | null;
}

/**
 * The bare facts about one item, with no user join and no access check.
 *
 * For worker jobs, which act on behalf of the system rather than a person. Anything serving
 * a request must use `findDetail` instead — it takes `userId` and the accessible root ids,
 * so an access check cannot be forgotten (§6).
 */
export const findBasic = (mediaId: string): MediaBasicRow | undefined =>
    db
        .prepare(
            `SELECT "id", "kind", "durationMs", "width", "height", "probedAt", "container",
                    "codec", "videoProfile", "pixFmt", "audioCodec"
               FROM "Media" WHERE "id" = ?`
        )
        .get(mediaId) as MediaBasicRow | undefined;

export interface TranscodeCandidateRow {
    id: string;
    fileId: string;
    /** Needed to tell an MKV from a WebM, which ffprobe cannot. */
    relPath: string;
    kind: "image" | "video";
    container: string | null;
    codec: string | null;
    videoProfile: string | null;
    pixFmt: string | null;
    audioCodec: string | null;
    probedAt: string | null;
}

/**
 * Probed videos with no finished web-safe rendition.
 *
 * Deliberately *not* filtered by playability here. Whether a browser can play a file is
 * decided by `assessPlayback` in @private-stock/core, and expressing that in SQL would mean a
 * second implementation of it that silently drifts from the first. This returns the
 * candidates and the columns needed to judge them; the caller judges.
 *
 * **KNOWN ISSUE (not fixed — ARCHITECTURE.md §8, "Deciding what needs transcoding at all").**
 * `LIMIT` with no `ORDER BY` and no cursor, filtered for playability only afterwards: when the
 * first `limit` rows are all directly playable, which in most libraries they are, every caller
 * gets nothing to do and the videos that do need a rendition are never reached. Harmless while
 * transcoding is off; fix it before switching transcoding on or touching this query.
 */
export const listTranscodeCandidates = (profile: string, limit = 500): TranscodeCandidateRow[] =>
    db
        .prepare(
            `SELECT m."id" AS "id", fl."fileId" AS "fileId", f."relPath" AS "relPath",
                    m."kind", m."container", m."codec",
                    m."videoProfile", m."pixFmt", m."audioCodec", m."probedAt"
               FROM "Media" m
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
               JOIN "MediaFile" f ON f."id" = fl."fileId" AND f."state" = 'active'
              WHERE m."kind" = 'video'
                AND m."probedAt" IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM "Variant" v
                     WHERE v."mediaId" = m."id" AND v."profile" = :profile AND v."ready" = 1
                )
              LIMIT :limit`
        )
        .all({ profile, limit }) as TranscodeCandidateRow[];

export interface ProbeResult {
    durationMs: number | null;
    width: number | null;
    height: number | null;
    codec: string | null;
    videoProfile: string | null;
    videoLevel: number | null;
    pixFmt: string | null;
    audioCodec: string | null;
    audioChannels: number | null;
    container: string | null;
    bitrate: number | null;
    fps: number | null;
    capturedAt: string | null;
    isAnimated: boolean;
}

export const applyProbe = (mediaId: string, probe: ProbeResult): void => {
    db.prepare(
        `UPDATE "Media"
            SET "durationMs" = ?, "width" = ?, "height" = ?, "codec" = ?, "container" = ?,
                "bitrate" = ?, "fps" = ?, "capturedAt" = ?, "isAnimated" = ?,
                "videoProfile" = ?, "videoLevel" = ?, "pixFmt" = ?,
                "audioCodec" = ?, "audioChannels" = ?,
                "probedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(
        probe.durationMs,
        probe.width,
        probe.height,
        probe.codec,
        probe.container,
        probe.bitrate,
        probe.fps,
        probe.capturedAt,
        probe.isAnimated ? 1 : null,
        probe.videoProfile,
        probe.videoLevel,
        probe.pixFmt,
        probe.audioCodec,
        probe.audioChannels,
        mediaId
    );
};

/**
 * Sort expressions, keyed so a caller can never inject one.
 *
 * Every sort ends with `m.id` as a tiebreaker. Without it, rows with equal sort values have
 * no stable order, and keyset paging silently skips or repeats items across page boundaries
 * — a bug that only shows up on real libraries where timestamps collide.
 */
/**
 * The ORDER BY for each sort, written to match a partial index exactly (§20).
 *
 * Every expression here is a bare column, and that is the whole point. The first version
 * wrapped three of them in COALESCE -- `COALESCE(m."durationMs", 0)` and friends -- to make
 * NULLs order predictably. It worked, and it silently cost a factor of ten thousand: an
 * ORDER BY over an *expression* cannot use an index on the column inside it, so SQLite fell
 * back to sorting the entire matching library into a temp B-tree on every page. Measured at
 * 200k items, that was 5.9 seconds per page for every sort, whether or not an index existed.
 *
 * NULLs now sort where SQLite puts them (first ascending, last descending) rather than being
 * coerced to zero. That is a visible behaviour change for unprobed items -- an unknown
 * duration no longer pretends to be 0:00 -- and it is the honest rendering anyway.
 */
const SORT_COLUMNS: Record<MediaQuery["sort"], string> = {
    addedAt: `m."addedAt"`,
    capturedAt: `m."capturedAt"`,
    title: `m."title" COLLATE NOCASE`,
    duration: `m."durationMs"`,
    size: `m."listSize"`,
    /**
     * The one expression served by an index, because the index is on the expression itself:
     * `idx_Media_list_resolution` is built over `MIN("width", "height")`, and SQLite walks an
     * expression index when the ORDER BY spells the same expression. It is the rule above
     * rather than an exception to it -- what disables an index is an ORDER BY that differs from
     * it, and this one does not. Edit the two together, and the measure filter's too, which
     * defines resolution the same way.
     */
    resolution: `MIN(m."width", m."height")`,
    bitrate: `m."bitrate"`,
    fps: `m."fps"`,
    /**
     * The viewer's row, and always the viewer's: a shared filter resolving against its owner
     * asks about their *ratings*, not about when they last opened something (§6).
     *
     * Per-user, so no index on Media can serve it and each page sorts the matching set -- the
     * same position as `rating`, and held to the same budget by `pnpm bench`. Unviewed items
     * have no row or a null, and go last whichever way round (see `nullsLast`).
     */
    lastViewed: `um."lastViewedAt"`,
    // Rewritten to the overlay alias by `sortColumn` when the query resolves against
    // somebody else's ratings; every other column is the library's and needs no such care.
    rating: `um."rating"`,
    /**
     * A seeded permutation of rowids, sorted like any other column (§20).
     *
     * `(a * rowid + b) mod p` with `p` prime and above every rowid is a bijection, so this
     * orders the *matching* rows into a shuffle that is stable for a seed. It is applied after
     * the WHERE clause like every other sort, which is the whole point: the version it
     * replaced chose a window of the whole table's rowids first and filtered afterwards, so
     * a narrow filter -- favourites -- came back as a few items on page one and the rest
     * scattered over thousands of blank pages.
     *
     * An expression, so no index serves it and each page sorts the matching set. That is
     * the price of a shuffle that pages densely; `pnpm bench` holds it to budget. Integer
     * arithmetic throughout: `a * rowid` stays under p², far inside 64 bits.
     */
    random: `((:shuffleA * m."rowid" + :shuffleB) % :shufflePrime)`,
    // Not a column: relevance comes from the FTS join, handled by `fromClause`.
    /**
     * Negated, and that fixes a bug this column has had since it was written.
     *
     * `bm25()` returns a *negative* number where more negative is a better match, so best-first
     * is ascending. `naturalDirection` calls relevance `desc` -- which is the right word for
     * what a person means by it -- and the two together produced `ORDER BY score DESC`: the
     * worst matches first, on every relevance search ever run. Nothing failed, the results
     * looked plausible, and no test asserted an order. `searchRepo` even warns about this
     * exact mistake in the comment above `MATCH_JOIN_SQL`.
     *
     * Negating makes higher mean better, so the honest word and the correct order agree.
     *
     * Coalesced because the join is a LEFT JOIN: an item matched only by one of the viewer's
     * private tags has no document score (§6). Zero is worse than every real negated score,
     * so those land after the text matches rather than ahead of them.
     */
    relevance: `-COALESCE(search."score", 0)`,
    /**
     * Not a column either, and never paged here: a look's order is ranked in the web process and
     * kept there (§5e "Search runs in two passes"), and the database is only asked which of it the
     * rest of the query allows (`matchingIds`). Date added stands in for anything that reaches this
     * anyway.
     */
    look: `m."addedAt"`,
};

/**
 * The grid's FROM clause.
 *
 * Driven from `Media` alone. It used to start at `MediaFile`, because that is where the
 * filters lived -- active, classified as media, in an accessible root -- while the sorts
 * lived on `Media`. No index can serve a filter and an ordering that sit on different
 * tables, so the planner had no choice but to gather every match and sort it.
 *
 * The three filter inputs are now denormalised onto `Media` (see `init.ts`), which lets one
 * partial index cover filter and order together. The file table is not joined here at all:
 * everything the grid renders from it -- size, path -- came along with them.
 *
 * `UserMedia` is still a join, and has to be: it is per-viewer, so it cannot be denormalised
 * onto a shared row. It is an indexed lookup on the primary key, which costs one probe per
 * row of the page rather than per row of the library.
 */
/**
 * What a tile draws besides the item itself: cover, preview, web-safe rendition. One probe
 * each per row returned, never per row considered — callers join these only once the rows
 * are decided.
 */
const TILE_JOINS = `
    LEFT JOIN "Artifact" chosen ON chosen."id" = m."coverArtifactId"
    LEFT JOIN "Artifact" generated ON generated."mediaId" = m."id"
                                  AND generated."kind" = 'cover' AND generated."ordinal" = 0
    LEFT JOIN "Artifact" preview ON preview."mediaId" = m."id"
                                AND preview."kind" = 'preview' AND preview."ordinal" = 0
    LEFT JOIN "Variant" websafe ON websafe."mediaId" = m."id"
                              AND websafe."profile" = 'websafe' AND websafe."ready" = 1
`;

const BASE_FROM = `
    FROM "Media" m
    LEFT JOIN "UserMedia" um ON um."mediaId" = m."id" AND um."userId" = :userId
    ${TILE_JOINS}
`;

/**
 * The original file behind a single item, as `f`.
 *
 * Separate from `BASE_FROM` on purpose. The list query deliberately stopped joining
 * `MediaFile` -- that is what made the library page constant time rather than library time,
 * and `listSize`/`listRelPath` are denormalised onto `Media` precisely so it does not have
 * to. A single-row lookup has no such problem: two index probes on a known id.
 *
 * It is an inner join, so an item whose original file is gone returns nothing rather than a
 * row with null paths. `findDetail` is what serving bytes resolves through, so "the file is
 * not there" must be a not-found, never a half-populated row that fails further down.
 */
const ORIGINAL_FILE_JOIN = `
    JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
    JOIN "MediaFile" f ON f."id" = fl."fileId"
`;

/**
 * The minimum needed to decide whether a row counts.
 *
 * Counting joins nothing it does not read. The full FROM above costs four extra index probes
 * per row for artifacts the count never looks at -- 3053 ms against 2835 ms at 200k, and the
 * gap widens with the number of things the grid learns to display.
 */
/** `COUNT_FROM` from a query's own source (`QueryBuild.source`). */
const countFrom = (source: string): string => `
    FROM ${source}
    LEFT JOIN "UserMedia" um ON um."mediaId" = m."id" AND um."userId" = :userId
`;

const COUNT_FROM = countFrom(`"Media" m`);

/**
 * The cover, and when it was made.
 *
 * A deliberate choice (`Media.coverArtifactId`) beats the generated one, which is what makes
 * "use this frame as the thumbnail" a single-row update rather than a file overwrite -- the
 * generated cover stays where it is, so reverting costs nothing and regeneration cannot
 * destroy the alternative someone picked.
 *
 * `coverGeneratedAt` exists so the served URL can carry a version. Without it the browser
 * caches the old picture under the same URL and a user who changes the cover sees no change
 * until they clear their cache, which reads as the feature being broken.
 */
const COVER_SELECTION = `
    COALESCE(chosen."relPath", generated."relPath") AS "coverPath",
    COALESCE(chosen."generatedAt", generated."generatedAt") AS "coverGeneratedAt",
    preview."relPath" AS "previewPath",
    preview."generatedAt" AS "previewGeneratedAt",
    websafe."relPath" AS "websafePath",
    websafe."height" AS "websafeHeight"
`;

interface QueryBuild {
    where: string[];
    params: Record<string, unknown>;
    /**
     * Where the rows come from: `"Media" m`, or the items a mentions filter matched joined to
     * `Media` (`MENTIONS_SOURCE`). Only a caller that asked to be driven can get the second, and
     * for it the mentions condition is this rather than a term of `where`.
     */
    source: string;
    /**
     * Which overlay the rating predicates and the rating sort read from.
     *
     * `um` — the viewer's — for everything except a shared filter its owner marked as
     * resolving against themselves, which is the only way `oum` ever appears (§6).
     */
    ratingAlias: string;
    /**
     * The group the rows come from, when `source` is its items (`groupSourceSql`): it is not
     * among `where`, and a caller deciding which joins the WHERE needs asks without it.
     */
    driven: FilterGroup | null;
}

/**
 * A second personal overlay, for someone who is not the viewer.
 *
 * Joined only when a query actually asks for one, and the presence of `:overlayUserId` in the
 * bound parameters is what says so — the same signal the FTS join uses. A query with no
 * overlay therefore produces byte-for-byte the SQL it produced before this existed, which
 * matters because this is the hottest query in the app and the overlay is the rare case.
 */
/**
 * Whether this query consults a personal overlay at all.
 *
 * Two things depend on the answer. Paging has to join `UserMedia` when it does, because the
 * predicate or the sort is in that table. And an overlay for somebody else is only bound when
 * it does — an owner-relative filter that never mentions ratings would otherwise pay for a
 * join whose columns nothing reads.
 */
const readsRatingRow = (query: MediaQuery): boolean =>
    query.sort === "rating" ||
    query.favorite === true ||
    query.unrated === true ||
    query.minRating !== undefined ||
    // Both ends of a rating band, and this list is the reason `maxRating` could not simply be
    // added to the schema: a predicate that reads the overlay without being named here builds
    // SQL mentioning `um` with no `um` joined -- "no such column: um.rating", on a query that
    // typechecks perfectly.
    query.maxRating !== undefined ||
    // The same trap one level down: a rating, favourite or unrated rule inside a group (§14e).
    rulesIn(query.groups).some(
        (rule) => rule.t === "favorite" || rule.t === "unrated" || rule.t === "rating"
    );

/**
 * Whose marks this query asks about at all -- the row's, or a favourite tag's.
 *
 * Wider than `readsRatingRow` by `favTags`: "any of my favourite performers" is a judgement
 * of somebody's and follows a shared filter's `resolveAs` like a rating does, but it reads
 * `UserTag` rather than the `UserMedia` row, so it must not force that join while paging.
 */
const usesPersonalOverlay = (query: MediaQuery): boolean =>
    readsRatingRow(query) || groupsArePersonal(query.groups);

/**
 * Whether paging has to join `UserMedia` at all.
 *
 * Deliberately a wider question than `usesPersonalOverlay`, and the two must not be
 * conflated. That one asks *whose* ratings a predicate is about, which is what picks the
 * overlay alias; this asks whether the viewer's own row is referenced by the WHERE clause,
 * which is what decides whether the join can be dropped in favour of the cheaper
 * hidden-by-exclusion path.
 *
 * `watched` is the case that separates them: it is always the viewer's, never an overlay's,
 * and it still needs the row. Reusing `usesPersonalOverlay` here produced a query naming
 * `um."watchedAt"` with no `um` in it -- a hard SQL error rather than wrong rows, which is
 * the good outcome, but only because the filter happened to be exercised.
 */
const needsUserJoin = (query: MediaQuery): boolean =>
    readsRatingRow(query) ||
    // The viewer's own row, like `watched`, so here rather than in `readsRatingRow`.
    query.sort === "lastViewed" ||
    query.watched !== undefined ||
    groupsReadUserMedia(query.groups);

const OVERLAY_JOIN = `
    LEFT JOIN "UserMedia" oum ON oum."mediaId" = m."id" AND oum."userId" = :overlayUserId
`;

const withOverlay = (from: string, params: Record<string, unknown>): string =>
    params.overlayUserId === undefined ? from : `${from} ${OVERLAY_JOIN}`;

interface GroupContext {
    /** The overlay the rating rules read, as for the flat rating fields. */
    ratingAlias: string;
    /** Whose favourite tags `favTags` means. */
    favUser: string;
}

/**
 * Any of somebody's favourite tags of one facet, on the item (§6 "Favourite tags").
 *
 * Scoped on the tag as well as the mark: a favourite of a tag that has since gone private to
 * somebody else must not keep matching through its old row. `userParam` names whose
 * favourites; `kindParam` the facet.
 */
const favoriteTagsSql = (kindParam: string, userParam: string): string =>
    `EXISTS (SELECT 1 FROM "MediaTag" fmt
               JOIN "UserTag" fut ON fut."tagId" = fmt."tagId"
                    AND fut."userId" = :${userParam} AND fut."favorite" IS NOT NULL
               JOIN "Tag" ft ON ft."id" = fmt."tagId" AND ft."kind" = :${kindParam}
                    AND (ft."ownerId" IS NULL OR ft."ownerId" = :${userParam})
              WHERE fmt."mediaId" = m."id"
                AND (fmt."userId" IS NULL OR fmt."userId" = :userId))`;

/**
 * One rule as a condition on `m`, its parameters bound under `name` (§14e).
 *
 * Tag rules never reach here: `groupSql` folds them into one tag condition per group, because
 * a separate `EXISTS` for each of twenty performers is twenty probes per row where one
 * `IN (...)` is one.
 */
const ruleSql = (
    rule: Exclude<FilterRule, { t: "tag" }>,
    name: string,
    params: Record<string, unknown>,
    context: GroupContext
): string => {
    switch (rule.t) {
        case "favTags":
            params[`${name}kind`] = rule.kind;
            params[`${name}user`] = context.favUser;

            return favoriteTagsSql(`${name}kind`, `${name}user`);
        case "untagged":
            params[`${name}kind`] = rule.kind;

            return `NOT EXISTS (SELECT 1 FROM "MediaTag" umt
                                  JOIN "Tag" ut ON ut."id" = umt."tagId" AND ut."kind" = :${name}kind
                                 WHERE umt."mediaId" = m."id"
                                   AND (umt."userId" IS NULL OR umt."userId" = :userId))`;
        case "favorite":
            return `${context.ratingAlias}."favorite" = 1`;
        case "unrated":
            return `${context.ratingAlias}."rating" IS NULL`;
        case "rating": {
            const parts: string[] = [];

            if (rule.min !== undefined) {
                parts.push(`${context.ratingAlias}."rating" >= :${name}min`);
                params[`${name}min`] = rule.min;
            }

            if (rule.max !== undefined) {
                parts.push(`${context.ratingAlias}."rating" <= :${name}max`);
                params[`${name}max`] = rule.max;
            }

            return parts.join(" AND ");
        }
        case "watched":
            // The viewer's own history, never an overlay's -- as the flat field.
            return rule.value === "yes" ? `um."watchedAt" IS NOT NULL` : `um."watchedAt" IS NULL`;
        case "measure": {
            const { column, scale } = MEASURE_SQL[rule.measure];

            return rangeClauses(column, name, rule.min, rule.max, scale, params).join(" AND ");
        }
        case "orientation":
            return ORIENTATION_SQL[rule.value];
        case "animated":
            return ANIMATED_SQL[rule.value];
        case "kind":
            params[`${name}kind`] = rule.value;

            return `m."kind" = :${name}kind`;
        case "root":
            // Inside the accessible roots already, because that clause is ANDed on every
            // query; an id outside them simply matches nothing.
            params[`${name}root`] = rule.id;

            return `m."listRootId" = :${name}root`;
    }
};

/**
 * A group as one parenthesised condition (§14e).
 *
 * `none` is `NOT (a OR b)` with each rule coalesced to false first. SQL's NULL would otherwise
 * leak through the NOT: "none of: at least four stars" asks `NOT (rating >= 4)`, which is NULL
 * for an unrated item, and NULL is not true -- so every unrated item would vanish from a filter
 * that, read aloud, plainly includes them.
 */
const groupSql = (
    group: FilterGroup,
    name: string,
    params: Record<string, unknown>,
    context: GroupContext
): string => {
    const conditions: string[] = [];
    const tagPlaceholders: string[] = [];

    group.rules.forEach((rule, index) => {
        if (rule.t === "tag") {
            const placeholder = `${name}t${index}`;

            params[placeholder] = rule.id;
            tagPlaceholders.push(`:${placeholder}`);
        } else {
            conditions.push(`(${ruleSql(rule, `${name}r${index}`, params, context)})`);
        }
    });

    if (tagPlaceholders.length > 0) {
        if (group.match === "all") {
            params[`${name}tagCount`] = tagPlaceholders.length;
            conditions.unshift(allTagsSql(tagPlaceholders, `${name}tagCount`));
        } else {
            conditions.unshift(anyTagSql(tagPlaceholders));
        }
    }

    if (group.match === "all") {
        return `(${conditions.join(" AND ")})`;
    }

    if (group.match === "any") {
        return `(${conditions.join(" OR ")})`;
    }

    return `NOT (${conditions.map((condition) => `coalesce(${condition}, 0)`).join(" OR ")})`;
};

/**
 * The rules a group can be driven from: each names its items through an index of its own.
 *
 * A tag's assignments (`idx_MediaTag_tagId`), somebody's favourite tags' assignments (from
 * `UserTag`), their rated items (`idx_UserMedia_rating`) and their favourites
 * (`idx_UserMedia_favorite`). The rest cannot be: `unrated` and `untagged` are absences, and
 * `watched`, the measures and the item's own facts have no index that lists the items they hold.
 */
type SourceRule = Extract<FilterRule, { t: "tag" | "favTags" | "favorite" | "rating" }>;

const isSourceRule = (rule: FilterRule): rule is SourceRule =>
    rule.t === "tag" || rule.t === "favTags" || rule.t === "favorite" || rule.t === "rating";

/**
 * A group's rules, when a whole-set statement may start from its items rather than walk the
 * library (`groupSourceSql`); null when it may not. An "any of" made only of rules with a source
 * can, and so can a single such rule, which means the same whatever the group's match says --
 * except "none of", whose items are the ones the source does not name.
 */
const sourceRulesOf = (group: FilterGroup): SourceRule[] | null => {
    const sources = group.rules.filter(isSourceRule);
    const drivable =
        sources.length === group.rules.length &&
        (group.match === "any" || (group.match === "all" && sources.length === 1));

    return drivable ? sources : null;
};

/**
 * A group's items, gathered from its rules' sources, as the start of the statement (§20 "The
 * disk, not the CPU").
 *
 * The "any of" a saved filter is most often made of -- my favourite performers, four stars and
 * up, my favourites -- was a condition on every item: a walk of the kind's index with, for each
 * item, a probe of the viewer's overlay and a correlated `EXISTS` over all of their favourite
 * tags. On the production replica that was 688 pages and 357 ms of CPU for the videos alone, and
 * 452 pages more for the images. Asked from the other side, each rule names its items from an
 * index -- a few pages each -- and their `UNION` is the group exactly, one row per item; the
 * matching set is then one probe per item into `idx_Media_listable_id_kind_root`, which carries
 * everything a kept order, a count or a shuffled page reads. 508 pages for both kinds at once,
 * 5-10 ms warm.
 *
 * Each branch is its rule's condition turned round, with the same scoping, so the union holds
 * exactly the items the group's condition admits and the group is not tested again:
 *
 * - a tag rule: the item's assignments of it that the viewer can see, as `anyTagSql`;
 * - `favTags`: assignments the viewer can see of a tag `favUser` marked favourite, of the facet,
 *   that is not somebody else's private tag -- `favoriteTagsSql` from the tag's end;
 * - `rating` and `favorite`: `rater`'s overlay rows, which is whoever the group's rating rules
 *   read (the viewer, or a shared filter's owner). An item with no row has neither, as the left
 *   join said.
 *
 * Everything else the query asks -- listable, the libraries, hidden, kind, every other group and
 * field -- stays in its WHERE and is asked of each item the union names. The `CROSS JOIN` keeps
 * the union first (SQLite never reorders one); `INDEXED BY` and the caller's `kind IN` term are
 * what make the index usable, since it is partial on that term and the planner, with no
 * statistics, otherwise probes the primary key and reads every row (1,391 pages, not 508). The
 * favourites branch names its index because the planner ties it with `idx_UserMedia_rating` on
 * `userId` and takes that one, which reads every overlay row the rater has (198 pages, not 3).
 */
const groupSourceSql = (
    rules: SourceRule[],
    name: string,
    params: Record<string, unknown>,
    context: { favUser: string; rater: string }
): string => {
    const sources: string[] = [];
    const tagPlaceholders: string[] = [];
    const rater = `:${name}rater`;

    rules.forEach((rule, index) => {
        const ruleName = `${name}r${index}`;

        switch (rule.t) {
            case "tag":
                params[ruleName] = rule.id;
                tagPlaceholders.push(`:${ruleName}`);
                break;
            case "favTags":
                params[`${ruleName}kind`] = rule.kind;
                params[`${ruleName}user`] = context.favUser;
                sources.push(
                    `fmt."mediaId" AS "mediaId" FROM "UserTag" fut
                       JOIN "Tag" ft ON ft."id" = fut."tagId" AND ft."kind" = :${ruleName}kind
                            AND (ft."ownerId" IS NULL OR ft."ownerId" = :${ruleName}user)
                       JOIN "MediaTag" fmt ON fmt."tagId" = fut."tagId"
                            AND (fmt."userId" IS NULL OR fmt."userId" = :userId)
                      WHERE fut."userId" = :${ruleName}user AND fut."favorite" IS NOT NULL`
                );
                break;
            case "favorite":
                params[`${name}rater`] = context.rater;
                sources.push(
                    `"mediaId" AS "mediaId"
                       FROM "UserMedia" INDEXED BY "idx_UserMedia_favorite"
                      WHERE "userId" = ${rater} AND "favorite" IS NOT NULL AND "favorite" = 1`
                );
                break;
            case "rating": {
                const bounds: string[] = [];

                if (rule.min !== undefined) {
                    bounds.push(`"rating" >= :${ruleName}min`);
                    params[`${ruleName}min`] = rule.min;
                }

                if (rule.max !== undefined) {
                    bounds.push(`"rating" <= :${ruleName}max`);
                    params[`${ruleName}max`] = rule.max;
                }

                params[`${name}rater`] = context.rater;
                sources.push(
                    `"mediaId" AS "mediaId" FROM "UserMedia"
                      WHERE "userId" = ${rater} AND ${bounds.join(" AND ")}`
                );
                break;
            }
        }
    });

    if (tagPlaceholders.length > 0) {
        sources.unshift(
            `"mediaId" AS "mediaId" FROM "MediaTag"
              WHERE "tagId" IN (${tagPlaceholders.join(", ")})
                AND ("userId" IS NULL OR "userId" = :userId)`
        );
    }

    // `UNION` makes one row per item however many rules name it. A lone rule needs `DISTINCT`
    // for the same: an item can carry two of the tags, or two of somebody's favourites.
    const select = sources.length === 1 ? "SELECT DISTINCT" : "SELECT";

    return `(${sources.map((body) => `${select} ${body}`).join(" UNION ")}) hit
        CROSS JOIN "Media" m INDEXED BY "idx_Media_listable_id_kind_root" ON m."id" = hit."mediaId"`;
};

/**
 * Whose personal overlay the rating predicates should read.
 *
 * `overlayUserId` is deliberately a parameter rather than a field on `MediaQuery`: the query
 * travels in URLs, and a client that could name the account whose ratings to filter by would
 * be able to read any other account's ratings one probe at a time. It can only be supplied by
 * a service that has already decided the viewer is allowed to see that person's judgements —
 * which today means exactly one thing, a filter its owner chose to share that way.
 */
const buildFilters = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    overlayUserId?: string,
    /**
     * Whether a short mentions match may become the query's starting point (`MENTIONS_SOURCE`).
     * Only for a statement that walks its own matching set -- a count, a page, a list of ids.
     * Never inside a correlated `EXISTS` (the facet counts), where the item is already pinned
     * and a join from the matches would replay them once per assignment.
     *
     * `driveGroups` lets an "any of" group of indexed sources be the starting point as well
     * (`groupSourceSql`). Only for a statement that reads its *whole* matching set -- a kept
     * order, a count, a shuffled page: a page in an indexed order stops walking when it is full,
     * and starting from the group would gather and sort every item of it first.
     */
    options: { drive?: boolean; driveGroups?: boolean } = {}
): QueryBuild => {
    /**
     * An overlay identical to the viewer's is not an overlay.
     *
     * The owner opening their own shared filter takes this path, and it has to produce the
     * ordinary query rather than a self-join that says the same thing more slowly.
     */
    const overlay =
        overlayUserId && overlayUserId !== userId && usesPersonalOverlay(query)
            ? overlayUserId
            : undefined;
    const ratingAlias = overlay ? "oum" : "um";
    // `listable` is the denormalised "active, classified as media, has an original file".
    // It is also the partial index's predicate, so naming it here is what lets the planner
    // choose that index at all.
    const where: string[] = [`m."listable" = 1`];
    const params: Record<string, unknown> = { userId };

    if (overlay) {
        params.overlayUserId = overlay;
    }

    /**
     * Hidden is always the *viewer's*, never the overlay's.
     *
     * Hiding an item is a standing instruction to the app — "do not show me this" — rather
     * than a predicate anyone wrote into a filter. Resolving it against the filter's owner
     * would resurface items this viewer had deliberately put away, which is the one thing
     * hiding exists to prevent.
     */
    where.push(`um."hidden" IS NULL`);

    /**
     * Watched is always the viewer's too, and for the same reason.
     *
     * It reads `um` rather than `ratingAlias`: what somebody has watched is their own
     * history rather than a judgement about the item, so resolving it against a shared
     * filter's owner would answer a question nobody asked and disclose one they did not
     * offer. "Dad's five stars that I have not seen" is the viewer's `unwatched` on top of
     * Dad's filter, exactly as §6 reads the equivalent request about ratings.
     */
    if (query.watched === "yes") {
        where.push(`um."watchedAt" IS NOT NULL`);
    } else if (query.watched === "no") {
        where.push(`um."watchedAt" IS NULL`);
    }

    if (rootIds.length === 0) {
        // No accessible roots must return nothing, not everything.
        where.push("1 = 0");
    } else {
        where.push(`m."listRootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})`);
        rootIds.forEach((id, i) => {
            params[`root${i}`] = id;
        });
    }

    if (query.kind) {
        where.push(`m."kind" = :kind`);
        params.kind = query.kind;
    }

    if (query.rootId) {
        where.push(`m."listRootId" = :rootId`);
        params.rootId = query.rootId;
    }

    /**
     * Text search, via FTS5 (§5c).
     *
     * This replaced a `LIKE '%term%'` over title and path, which could not use an index at
     * all: every search read every row, and it matched only literal substrings, so "jane
     * doe" missed "Doe, Jane" and a typo returned nothing rather than something close.
     *
     * When the sort is by relevance the match arrives as a join instead, because the score
     * has to come back with the row -- `appendRelevanceJoin` below owns that half. Both use
     * the same `:match` parameter, so it is bound here either way.
     */
    const match = query.search ? searchRepo.matchExpression(query.search) : null;

    if (match) {
        params.match = match;

        /**
         * Each word, matched in the document or among the viewer's own tags (§5c "One search
         * across what you can see"), and each excluded word the same way. Scoped to `:userId`,
         * which is already bound on every path through here and comes from the session rather
         * than the query.
         */
        const terms = searchTerms(query.search ?? "");

        terms.included.forEach((term, index) => {
            params[`mw${index}`] = term.fts;
            params[`pt${index}`] = term.patterns.words;
            params[`ps${index}`] = term.patterns.squashed;
        });
        terms.excluded.forEach((term, index) => {
            params[`mx${index}`] = term.fts;
            params[`px${index}`] = term.patterns.words;
            params[`pxs${index}`] = term.patterns.squashed;
        });

        /**
         * Pushed for every sort, relevance included.
         *
         * It used to be skipped when ordering by relevance, because the inner join did the
         * filtering as a side effect. The join is a LEFT JOIN now -- an item found only by a
         * private tag has no document score, and an inner join would drop it from
         * relevance-sorted results alone -- so the WHERE is what narrows, in one place, for
         * every order.
         */
        where.push(searchRepo.matchFilterSql(terms.included.length, terms.excluded.length));
    } else if (query.search) {
        // The search was all punctuation, so it has no tokens to match. Returning the
        // unfiltered library would look like the search box had been ignored.
        where.push("1 = 0");
    }

    /**
     * Items whose text names a tag (§5d "Find untagged").
     *
     * A tag this viewer cannot see, or one whose names are all punctuation, matches nothing
     * rather than everything: the filter asked a question, and the unfiltered library is not
     * its answer.
     */
    let source = `"Media" m`;

    if (query.mentions) {
        /**
         * The items whose own text names the tag, as the one name matcher found them (§5b "One
         * rule for names"): a stored fact, kept fresh by the worker, rather than an FTS query over
         * the tag's names — which also matched other tags' names in the document and missed a
         * name glued inside a longer word until the item was next reindexed.
         *
         * Somebody else's private tag names nothing for this viewer.
         */
        const tag = tagRepo.findById(query.mentions);

        if (!tag || (tag.ownerId !== null && tag.ownerId !== userId)) {
            where.push("1 = 0");
        } else {
            params.mentions = query.mentions;

            if (options.drive && drivesFromMatches(mentionRepo.countMentioned(query.mentions))) {
                source = MENTIONS_SOURCE;
            } else {
                where.push(mentionRepo.MENTION_FILTER_SQL);
            }
        }
    }

    /**
     * Tags, ANDed.
     *
     * Selecting two performers means items with both, not either. OR semantics would make
     * every extra selection *widen* the results, which reads as the filter being broken --
     * and it is the wrong question anyway: nobody narrows a library by adding alternatives.
     */
    if (query.tags && query.tags.length > 0) {
        where.push(
            allTagsSql(
                query.tags.map((_, i) => `:tag${i}`),
                "tagCount"
            )
        );

        query.tags.forEach((tagId, i) => {
            params[`tag${i}`] = tagId;
        });
        params.tagCount = query.tags.length;
    }

    /**
     * Without any of these: the filter panel's excluded chips (§14e).
     *
     * `NOT EXISTS` over the item's own assignments, in either system the viewer can see -- an
     * exclusion of a private tag of theirs works, and somebody else's private tag can exclude
     * nothing because none of its assignments are visible here.
     */
    if (query.notTags && query.notTags.length > 0) {
        const placeholders = query.notTags.map((id, i) => {
            params[`notTag${i}`] = id;

            return `:notTag${i}`;
        });

        where.push(`NOT ${anyTagSql(placeholders)}`);
    }

    /**
     * Any, all or none of a list of rules, each group one more ANDed condition (§14e).
     *
     * `favUser` is whose favourites "any of my favourite performers" means: the overlay's when
     * a shared filter resolves against its owner, exactly as its ratings do, else the viewer's.
     */
    const favUser = overlay ?? userId;
    let driven: FilterGroup | null = null;

    (query.groups ?? []).forEach((group, index) => {
        const sources =
            options.driveGroups && driven === null && source === `"Media" m`
                ? sourceRulesOf(group)
                : null;

        if (sources === null) {
            where.push(groupSql(group, `g${index}`, params, { ratingAlias, favUser }));
            return;
        }

        // The group's own items are the rows, so it is not asked again of each of them; the
        // `kind IN` term is always true and is what lets the source's index be used at all.
        driven = group;
        source = groupSourceSql(sources, `g${index}`, params, {
            favUser,
            rater: overlay ?? userId,
        });
        where.push(`m."kind" IN ('image', 'video')`);
    });

    if (query.favorite) {
        where.push(`${ratingAlias}."favorite" = 1`);
    }

    if (query.unrated) {
        where.push(`${ratingAlias}."rating" IS NULL`);
    }

    if (query.minRating !== undefined) {
        where.push(`${ratingAlias}."rating" >= :minRating`);
        params.minRating = query.minRating;
    }

    if (query.maxRating !== undefined) {
        where.push(`${ratingAlias}."rating" <= :maxRating`);
        params.maxRating = query.maxRating;
    }

    appendMeasureFilters(query, where, params);

    return { where, params, ratingAlias, source, driven };
};

/**
 * The items a mentions filter matched, joined to `Media` -- the query driven from the matches.
 *
 * Written as a filter, `m."id" IN (matches)`, the planner (no statistics) starts from `Media`:
 * it walks every listable item of the kind in `idx_Media_list_kind_addedAt` and probes each
 * against the list. That walk is the library -- 156 pages for the images on the production
 * replica, 270 for the videos, ~2,500 at 200k -- for a tag whose name appears in a few dozen
 * files. From the matches it is one probe per match. `CROSS JOIN` because SQLite never
 * reorders one; one row per item because the matches have one per item.
 */
const MENTIONS_SOURCE = `(${mentionRepo.MENTIONED_IDS_SQL}) hit
    CROSS JOIN "Media" m ON m."id" = hit."mediaId"`;

/**
 * Up to how many matches a mentions query starts from the matches rather than from `Media`.
 *
 * Each match costs about a page from the matches' side -- its `Media` row, at random -- and the
 * walk from `Media`'s side costs about a page per thirty listable items of a kind, whatever
 * matched. So the matches win while they number fewer than the walk's pages: a kind is roughly
 * half the library, hence the library's size over sixty. `max(rowid)` stands in for the size
 * because it is a descent to one leaf where `count(*)` is a walk; it can only overstate (rowids
 * freed below the top are not reused), which tips a borderline query toward the matches. Wrong in
 * either direction, the cost is bounded by the other plan's.
 *
 * Measured on the production replica (13k items), images: a tag mentioned in 76 files, 205
 * pages from `Media` and 120 from the matches; one mentioned in 638, 263 against 389 -- so that
 * one stays a walk.
 */
const MATCHES_PER_WALKED_PAGE = 60;
const MIN_DRIVING_MATCHES = 100;

const drivesFromMatches = (matches: number): boolean =>
    matches <= Math.max(MIN_DRIVING_MATCHES, newestRowid() / MATCHES_PER_WALKED_PAGE);

/**
 * A half-open range over one column (§14e).
 *
 * `>= min` and `< max`, never `<=` on the upper bound. The bands in `ranges.ts` are adjacent
 * — 720p ends exactly where 1080p begins — so an inclusive maximum would count a
 * 1080-pixel-high video under both, and the two filters that are supposed to be alternatives
 * would overlap. One helper rather than a pair of pushes at each of five call sites, because
 * that is five chances to type `<=` once.
 *
 * `scale` converts the URL's unit to the column's. The query speaks seconds, kbps and
 * megabytes because those are what a person can read in an address bar; the columns hold
 * milliseconds, bits per second and bytes.
 *
 * **NULL fails both comparisons, and that is the intended answer.** An image has no duration,
 * so it is not "between one and five minutes" — it is not a candidate for the question at
 * all. The filter panel says so by only offering a duration filter where it can mean
 * something, rather than by having the SQL pretend an absent value is zero.
 */
const rangeClauses = (
    column: string,
    name: string,
    min: number | undefined,
    max: number | undefined,
    scale: number,
    params: Record<string, unknown>
): string[] => {
    const clauses: string[] = [];

    if (min !== undefined) {
        clauses.push(`${column} >= :min${name}`);
        params[`min${name}`] = min * scale;
    }

    if (max !== undefined) {
        clauses.push(`${column} < :max${name}`);
        params[`max${name}`] = max * scale;
    }

    return clauses;
};

/**
 * Each measure's column and the factor from the URL's unit to the column's (§14e).
 *
 * One table for the filter panel's bounds and for a group's measure rules, so the two cannot
 * disagree about what "1080p" or "twenty minutes" means.
 *
 * Resolution is the shorter side, not the height. `MIN` over the two columns rather than
 * `m."height"`, so an upright phone video at 1080×1920 is 1080p like the landscape frame it is
 * a rotation of. Reading height alone promoted every portrait item by a tier or two, which is
 * wrong in the direction nobody checks: the item appears under a filter it does not deserve
 * rather than vanishing from one it does. An expression, so no index serves it; that is
 * affordable because `listable` and the root clause have already narrowed the candidates.
 *
 * Size is `listSize`, the denormalised size of the original file already on Media -- so it
 * needs no join, and stays usable by the count and the facet queries unchanged.
 */
const MEASURE_SQL: Record<FilterMeasure, { column: string; scale: number }> = {
    durationSec: { column: `m."durationMs"`, scale: 1_000 },
    bitrateKbps: { column: `m."bitrate"`, scale: 1_000 },
    fps: { column: `m."fps"`, scale: 1 },
    resolution: { column: `MIN(m."width", m."height")`, scale: 1 },
    sizeMb: { column: `m."listSize"`, scale: 1_024 * 1_024 },
};

/**
 * Orientation, read from the generated column `Media.orientation` (§14e).
 *
 * It used to be compared here from the two sides, and deliberately had no column: a third fact
 * kept in step with two already there would be a third thing to get wrong on every re-probe. A
 * *generated* column answers that -- SQLite computes it from `width` and `height` and nothing
 * writes it, so it cannot disagree with them -- and it gives the planner what a comparison could
 * not, an index (`idx_Media_list_orientation`). Comparing the sides read every candidate's row:
 * a portrait shuffle of the videos on the production replica was 1,429 pages, against 275 for the
 * same walk with no orientation (§20 "The disk, not the CPU").
 *
 * The column's definition is the comparisons this replaced, so both sides must still be present:
 * an item that was never probed has no orientation rather than a square one, and is NULL here.
 */
const ORIENTATION_SQL: Record<"landscape" | "portrait" | "square", string> = {
    landscape: `m."orientation" = 'landscape'`,
    portrait: `m."orientation" = 'portrait'`,
    square: `m."orientation" = 'square'`,
};

/**
 * Animated stills, and only stills.
 *
 * The `kind` clause is not redundant. `isAnimated` is 1 or NULL on every row including videos,
 * so "not animated" without it would match the entire video collection -- and "stills only"
 * returning every film in the library is the kind of wrong that reads as the filter having
 * been ignored.
 */
const ANIMATED_SQL: Record<"yes" | "no", string> = {
    yes: `m."kind" = 'image' AND m."isAnimated" = 1`,
    no: `m."kind" = 'image' AND m."isAnimated" IS NULL`,
};

/** The flat bounds, as `?minDurationSec=` and friends spell them. */
const FLAT_MEASURES: {
    measure: FilterMeasure;
    name: string;
    min: keyof MediaQuery;
    max: keyof MediaQuery;
}[] = [
    { measure: "durationSec", name: "Duration", min: "minDurationSec", max: "maxDurationSec" },
    { measure: "bitrateKbps", name: "Bitrate", min: "minBitrateKbps", max: "maxBitrateKbps" },
    { measure: "fps", name: "Fps", min: "minFps", max: "maxFps" },
    { measure: "resolution", name: "Resolution", min: "minResolution", max: "maxResolution" },
    { measure: "sizeMb", name: "Size", min: "minSizeMb", max: "maxSizeMb" },
];

/**
 * Everything filtered by measuring the file rather than by asking a person about it (§14e).
 *
 * Separated from `buildFilters` because it is a different kind of predicate, and the
 * difference matters for more than tidiness: none of these touch the per-user overlay, so
 * none of them can be viewer-relative and none needs `ratingAlias`. A measure is a fact about
 * the file and reads the same for everybody who can see it.
 */
const appendMeasureFilters = (
    query: MediaQuery,
    where: string[],
    params: Record<string, unknown>
): void => {
    for (const flat of FLAT_MEASURES) {
        const { column, scale } = MEASURE_SQL[flat.measure];

        where.push(
            ...rangeClauses(
                column,
                flat.name,
                query[flat.min] as number | undefined,
                query[flat.max] as number | undefined,
                scale,
                params
            )
        );
    }

    if (query.orientation) {
        where.push(ORIENTATION_SQL[query.orientation]);
    }

    if (query.animated) {
        where.push(ANIMATED_SQL[query.animated]);
    }
};

/**
 * The FROM clause, with the relevance join spliced in when it is needed.
 *
 * Relevance is the one sort whose ordering value does not exist on any table -- it is
 * computed by the FTS index for this particular query. So unlike every other sort, which
 * only changes the ORDER BY, this one changes what is being selected from.
 */
const fromClause = (query: MediaQuery, params: Record<string, unknown>): string =>
    withOverlay(
        query.sort === "relevance" && params.match !== undefined
            ? `${BASE_FROM} ${searchRepo.MATCH_JOIN_SQL}`
            : BASE_FROM,
        params
    );

/** The ORDER BY column, pointed at whichever overlay this query's ratings come from. */
const sortColumn = (query: MediaQuery, ratingAlias: string): string => {
    const column = SORT_COLUMNS[query.sort] || `m."addedAt"`;

    return query.sort === "rating" ? `${ratingAlias}."rating"` : column;
};

/**
 * Never-viewed items after the viewed ones, in both directions.
 *
 * SQLite puts NULLs first ascending, which for last viewed would open "longest ago" on every
 * item never opened at all -- most of the library -- ahead of the one watched a year back that
 * the order was asked for. Only here: on the other sorts NULLs are left where SQLite puts them
 * (see `SORT_COLUMNS`), because `NULLS LAST` on an indexed sort stops the index serving it.
 * This sort has no index to lose.
 */
const nullsLast = (query: MediaQuery): string => (query.sort === "lastViewed" ? " NULLS LAST" : "");

export interface ListResult {
    rows: MediaListRow[];
    page: number;
    pageSize: number;
    hasMore: boolean;
}

const SELECTION = `
    SELECT m."id", m."kind", m."title", m."durationMs", m."width", m."height",
           m."addedAt", m."capturedAt", m."probedAt",
           m."container", m."codec", m."videoProfile", m."pixFmt", m."audioCodec",
           m."listSize" AS "sizeBytes", m."listRelPath" AS "relPath",
           ${COVER_SELECTION},
           um."rating", um."favorite", um."watchedAt"
`;

/**
 * The three numbers `SORT_COLUMNS.random` needs, bound only when shuffling.
 *
 * Over a fixed range rather than one sized to the library (`rowidShuffleParams`), so a seed
 * keeps its order when a scan adds items -- leaving a shuffle and coming back shows the same
 * list.
 */
const shuffleBindings = (query: MediaQuery): Record<string, number> => {
    if (query.sort !== "random") {
        return {};
    }

    const { a, b, prime } = rowidShuffleParams(query.seed ?? 1);

    return { shuffleA: a, shuffleB: b, shufflePrime: prime };
};

/**
 * One page of the library.
 *
 * Offset paging, which is the right choice *now* and was the wrong one before. The cost of
 * an offset is walking the rows it skips; when the ORDER BY had no index that meant sorting
 * the whole library first, and the offset was the least of it. Against a partial index the
 * walk is index entries only: 0.1 ms at page 1, 4.8 ms at page 100, 184 ms at the last page
 * of 200k items -- cheap enough to buy direct addressing of any page.
 *
 * No count is taken here. See `countMedia`.
 */
/**
 * Sorts and filters that need the per-user row while *paging*, not merely while rendering.
 *
 * This is the distinction that decides whether a deep page is cheap. `um."rating"` as an
 * ordering, or "favourites only" as a filter, has to be known for every row the offset walks
 * past. Everything else only has to be known for the sixty rows that come back.
 */
/**
 * Items this viewer has hidden.
 *
 * Fetched as a list rather than joined, because `um."hidden" IS NULL` costs one indexed probe
 * per row the offset *walks past* -- 180,000 of them on the last page of a large library, and
 * it is what stopped the index being covering. Excluding a handful of ids instead keeps the
 * paging query inside the index entirely: measured at offset 180,000, 185 ms became 29 ms,
 * and at offset 60,000, 56 ms became 1.8 ms.
 *
 * Hiding is rare by nature, but not bounded by anything, so a viewer who has hidden a great
 * many items falls back to the join rather than building a vast parameter list.
 */
const HIDDEN_INLINE_LIMIT = 500;

const hiddenMediaIds = (userId: string): string[] | null => {
    // INDEXED BY because the planner will not pick the partial index on its own: with no
    // statistics it ties with `idx_UserMedia_rating` on `userId = ?` and takes that one, which
    // reads every overlay row the viewer has to find the few hidden ones -- 43 pages for 689
    // rows on the production replica, on every page of the grid and every home shelf, against
    // two. Naming it makes a renamed or dropped index an error rather than a quiet regression.
    const rows = db
        .prepare(
            `SELECT "mediaId" FROM "UserMedia" INDEXED BY "idx_UserMedia_hidden"
              WHERE "userId" = ? AND "hidden" IS NOT NULL
              LIMIT ?`
        )
        .all(userId, HIDDEN_INLINE_LIMIT + 1) as { mediaId: string }[];

    return rows.length > HIDDEN_INLINE_LIMIT ? null : rows.map((row) => row.mediaId);
};

/**
 * The paging statement for a query, in parts: what it reads, which rows count, in what order.
 *
 * `params` and `order` come back beside it because hydrating has to bind and order the same
 * way. Shared by `pageIds`, `orderedRowids` and `countMedia`, so a page of the grid, the whole
 * order the web process keeps for a shuffle (§20) and the count cannot disagree about what
 * matches or where it goes.
 *
 * `whole` says the statement reads the entire matching set -- a count, a kept order, a shuffled
 * page -- so it may start from an "any of" group's own items (`groupSourceSql`).
 */
const pagingStatement = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    overlayUserId: string | undefined,
    whole: boolean
): {
    from: string;
    where: string;
    pagingParams: Record<string, unknown>;
    params: Record<string, unknown>;
    order: string;
} => {
    const { where, params, ratingAlias, source, driven } = buildFilters(
        query,
        userId,
        rootIds,
        overlayUserId,
        { drive: true, driveGroups: whole }
    );

    // Shuffle is an ordinary sort now, so it pages exactly like the others: filter, order,
    // offset. Its three numbers go into `params` because both the paging query and the
    // hydration below order by it.
    Object.assign(params, shuffleBindings(query));

    // Absent means "whichever way this sort naturally reads" -- ascending for a title,
    // descending for anything else. Defaulting to DESC here is what made picking "Title"
    // list the library from Z to A.
    const direction = (query.direction ?? naturalDirection(query.sort)) === "desc" ? "DESC" : "ASC";
    const order = `ORDER BY ${sortColumn(query, ratingAlias)} ${direction}${nullsLast(query)}, m."id" ${direction}`;

    /**
     * Page over the index, then join.
     *
     * SQLite applies OFFSET by counting *output* rows, so the four artifact joins and the
     * variant join are evaluated for every row that is then discarded -- at page 3000 that is
     * 180,000 rows joined five ways to produce sixty. The inner query below touches only the
     * partial index, so the rows it skips cost an index step each and nothing more.
     *
     * One extra row answers "is there another page" without counting. Comparing the page
     * length against the page size is wrong the moment a page can be legitimately short, and
     * a count is three orders of magnitude dearer than the page itself.
     *
     * Whether the join is needed is asked of the query less any group it is driven from: that
     * group's ratings are read by its source (`groupSourceSql`), not through the join.
     */
    const rest =
        driven === null ? query : { ...query, groups: query.groups?.filter((g) => g !== driven) };
    const hidden = needsUserJoin(rest) ? null : hiddenMediaIds(userId);
    const pagingWhere = [...where];
    const pagingParams: Record<string, unknown> = { ...params };

    let pagingJoin = "";

    if (hidden === null) {
        // Either a per-user sort or filter is in play, or this viewer has hidden more items
        // than are worth inlining. Both mean the row has to be joined while paging.
        pagingJoin = `LEFT JOIN "UserMedia" um ON um."mediaId" = m."id" AND um."userId" = :userId`;

        // And when the predicates name somebody else's overlay, that has to be here too --
        // the WHERE clause below refers to it by alias.
        pagingJoin = withOverlay(pagingJoin, params);
    } else {
        // `um."hidden" IS NULL` was added by buildFilters and is now expressed by exclusion.
        const index = pagingWhere.indexOf(`um."hidden" IS NULL`);

        if (index >= 0) {
            pagingWhere.splice(index, 1);
        }

        if (hidden.length > 0) {
            pagingWhere.push(`m."id" NOT IN (${hidden.map((_, i) => `:hidden${i}`).join(", ")})`);
            hidden.forEach((id, i) => {
                pagingParams[`hidden${i}`] = id;
            });
        }
    }

    const relevanceJoin =
        query.sort === "relevance" && params.match !== undefined ? searchRepo.MATCH_JOIN_SQL : "";

    return {
        from: `${source} ${pagingJoin} ${relevanceJoin}`,
        where: pagingWhere.join(" AND "),
        pagingParams,
        params,
        order,
    };
};

/**
 * The ids of one window of a query's ordering, from the paging query alone.
 *
 * Shared by `listMedia` and `shuffledIds`, so a home shelf drawing a sample and the grid
 * paging the same filter cannot disagree about what matches.
 */
const pageIds = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    overlayUserId: string | undefined,
    limit: number,
    offset: number
): { ids: string[]; params: Record<string, unknown>; order: string } => {
    // A shuffle reads its whole matching set whichever page is asked for; every other sort is a
    // walk that stops when the page is full.
    const { from, where, pagingParams, params, order } = pagingStatement(
        query,
        userId,
        rootIds,
        overlayUserId,
        query.sort === "random"
    );

    const ids = db
        .prepare(`SELECT m."id" FROM ${from} WHERE ${where} ${order} LIMIT :limit OFFSET :offset`)
        .pluck()
        .all({ ...pagingParams, limit, offset }) as string[];

    return { ids, params, order };
};

export const listMedia = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    overlayUserId?: string
): ListResult => {
    const { ids, params, order } = pageIds(
        query,
        userId,
        rootIds,
        overlayUserId,
        query.limit + 1,
        query.page * query.limit
    );
    const hasMore = ids.length > query.limit;
    const wanted = ids.slice(0, query.limit);

    if (wanted.length === 0) {
        return { rows: [], page: query.page, pageSize: query.limit, hasMore: false };
    }

    /**
     * Hydrated through the *viewer's* overlay, whichever overlay did the filtering.
     *
     * A shared filter resolving against its owner asks about their ratings; it does not claim
     * their ratings are yours. The tile shows what you gave the item, or nothing.
     */
    const FROM = fromClause(query, params);

    const rows = db
        .prepare(
            `${SELECTION} ${FROM}
              WHERE m."id" IN (SELECT value FROM json_each(:ids))
              ${order}`
        )
        .all({ ...params, ids: JSON.stringify(wanted) }) as MediaListRow[];

    return { rows, page: query.page, pageSize: query.limit, hasMore };
};

/**
 * One page of the library as ids alone: `listMedia` without the hydration (§14b, §20).
 *
 * The same `pageIds` walk with the same extra row for `hasMore`, so the ids and their order are
 * exactly the page's -- for the viewer, which steps through the set and draws one item at a
 * time. The hydration it skips is the dear half: the four artifact joins, the overlay and the
 * tags for every row, about five cold pages a tile.
 */
export const listMediaIdsPage = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    overlayUserId?: string
): { ids: string[]; page: number; pageSize: number; hasMore: boolean } => {
    const { ids } = pageIds(
        query,
        userId,
        rootIds,
        overlayUserId,
        query.limit + 1,
        query.page * query.limit
    );

    return {
        ids: ids.slice(0, query.limit),
        page: query.page,
        pageSize: query.limit,
        hasMore: ids.length > query.limit,
    };
};

/**
 * A uniform random sample of the items a query matches: the first `count` of a fresh shuffle.
 *
 * Ids only, for a caller that keeps the sample and draws from it rather than hydrating it all
 * -- the home page's shuffled shelves (§6, §20). Costs what a shuffled page does, a walk of the
 * whole matching set, which is exactly why the caller should not ask often.
 */
export const shuffledIds = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    count: number,
    seed: number,
    overlayUserId?: string
): string[] =>
    pageIds({ ...query, sort: "random", seed }, userId, rootIds, overlayUserId, count, 0).ids;

/**
 * A query's whole order, as rowids with each item's kind (§20 "A shuffle is sorted once").
 *
 * The paging statement without its window: one walk of the matching set, which is what any page
 * of a shuffle costs anyway, kept by the web process so the pages after it cost nothing like it.
 * Rowids rather than ids because the caller holds them in memory -- eight bytes each in a typed
 * array, against a 36-character string apiece -- and `stillMatching` turns them back into ids.
 *
 * The kind comes with each, as its index in `mediaKinds`, so one order taken without a kind
 * serves both kind tabs: a tab's order is the slots of its kind, in the same order (§20 "One walk
 * serves both kind tabs"). It is read from the same index entry as the rowid, so it costs nothing.
 *
 * Returns up to `cap + 1`, so a caller can tell an order it may keep from one too long to.
 */
export const orderedRowids = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    cap: number,
    overlayUserId?: string
): { rowids: number[]; kinds: Uint8Array } => {
    const { from, where, order, pagingParams } = pagingStatement(
        query,
        userId,
        rootIds,
        overlayUserId,
        true
    );
    const rows = db
        .prepare(`SELECT m."rowid", m."kind" FROM ${from} WHERE ${where} ${order} LIMIT :limit`)
        .raw()
        .all({ ...pagingParams, limit: cap + 1 }) as [number, MediaKind][];

    return {
        rowids: rows.map(([rowid]) => rowid),
        kinds: Uint8Array.from(rows, ([, kind]) => mediaKinds.indexOf(kind)),
    };
};

/** An item a kept order holds; its kind, because a look caps each kind separately (§5e). */
export interface MatchingRow {
    rowid: number;
    id: string;
    kind: MediaKind;
}

/**
 * Which of these rowids the query still matches, as ids, in the order given.
 *
 * The other half of a kept order: membership is decided again for the slice being served, with
 * exactly the query's own conditions -- listable, the viewer's libraries and hidden items, and the
 * filter itself -- so an item tagged, rated, hidden or trashed out of the set since the order was
 * taken does not come back with it. Driven from the rowids through a `CROSS JOIN`, which SQLite
 * never reorders: one rowid probe per item and the filter's own probes, never a walk.
 */
export const stillMatching = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    rowids: readonly number[],
    overlayUserId?: string
): MatchingRow[] => matchingIn("rowid", query, userId, rootIds, rowids, overlayUserId);

/**
 * Which of these ids the query matches, in the order given, with their rowids.
 *
 * `stillMatching` driven from ids: a look's order arrives as ids, ranked in the web process
 * from vectors filed under them (§5e "Search runs in two passes"), and becomes a kept order by
 * being checked against the rest of the query a slice at a time.
 */
export const matchingIds = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    ids: readonly string[],
    overlayUserId?: string
): MatchingRow[] => matchingIn("id", query, userId, rootIds, ids, overlayUserId);

const matchingIn = (
    key: "rowid" | "id",
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    wanted: readonly (number | string)[],
    overlayUserId?: string
): MatchingRow[] => {
    if (wanted.length === 0) {
        return [];
    }

    // Not driven from a mentions match: the list given is the starting point here, and the
    // match is one filter among the rest.
    const { where, params } = buildFilters(query, userId, rootIds, overlayUserId);

    return db
        .prepare(
            `SELECT m."rowid" AS "rowid", m."id" AS "id", m."kind" AS "kind"
               FROM json_each(:wanted) wanted
              CROSS JOIN "Media" m ON m."${key}" = wanted."value"
               LEFT JOIN "UserMedia" um ON um."mediaId" = m."id" AND um."userId" = :userId
               ${params.overlayUserId === undefined ? "" : OVERLAY_JOIN}
              WHERE ${where.join(" AND ")}
              ORDER BY wanted."key"`
        )
        .all({ ...params, wanted: JSON.stringify(wanted) }) as MatchingRow[];
};

/**
 * The highest rowid in `Media`: a descent to one leaf, never a walk.
 *
 * It rises when an item is added, which is how a kept order notices that something has arrived
 * since it was taken, and it stands in for the library's size where a count would be a walk.
 * Without `AUTOINCREMENT` a purge of the newest item lets the next one reuse its rowid, so that
 * one arrival goes unnoticed -- until the kept order expires, which is minutes.
 */
export const newestRowid = (): number =>
    (db.prepare(`SELECT max(rowid) FROM "Media"`).pluck().get() as number | null) ?? 0;

/**
 * How many items match, exactly.
 *
 * Separate from the page on purpose (§20). This is a scan of the whole matching set -- 188 ms
 * at 200k items even with the index, against 0.4 ms for a page -- so folding it into every
 * page request would make paging cost far more than the rows it returns. What changes the
 * answer is the *filter*, and the filter is stable while a person pages through it, so the
 * caller fetches this once per filter and reuses it.
 *
 * The same number whatever the sort, shuffle included: a sort orders the matching set and
 * never changes it (§20).
 */
export const countMedia = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    overlayUserId?: string
): number => {
    /**
     * The paging statement's own FROM and WHERE, ordering left off.
     *
     * It used to join `UserMedia` for every row to test `hidden`, where paging excludes the
     * viewer's few hidden items by id and stays inside the index (§20 "Pages, not an endless
     * scroll"). Counting the same way reads what a page walk reads: on the production replica
     * 722 pages → 538 for untagged videos, 460 → 275 for all videos.
     */
    const { from, where, pagingParams } = pagingStatement(
        query,
        userId,
        rootIds,
        overlayUserId,
        true
    );

    return db
        .prepare(`SELECT count(*) AS n FROM ${from} WHERE ${where}`)
        .pluck()
        .get(pagingParams) as number;
};

export interface MediaDetailRow extends MediaListRow {
    /**
     * Whether this viewer has hidden the item.
     *
     * Present on the detail but not the list, because the list has already excluded hidden
     * items -- there, the column would be a constant. Here it is what lets the UI show the
     * control in the right state rather than guessing.
     */
    hidden: number | null;
    /** When this viewer finished with the item, or null (§14b). */
    watchedAt: string | null;
    /**
     * This viewer's private note, or null (§6, §14b).
     *
     * On the detail only. A grid tile has nowhere to put two thousand characters, and
     * joining every tile to text it would never draw is payload spent on nothing.
     */
    note: string | null;
    spriteVttPath: string | null;
    spriteVttGeneratedAt: string | null;
    bitrate: number | null;
    fps: number | null;
    rootId: string;
    rootLabel: string;
    rootWritable: number | null;
    relPath: string;
}

export const findDetail = (
    mediaId: string,
    userId: string,
    rootIds: string[]
): MediaDetailRow | undefined => {
    if (rootIds.length === 0) {
        return undefined;
    }

    const rootParams = Object.fromEntries(rootIds.map((id, i) => [`root${i}`, id]));

    return db
        .prepare(
            `SELECT m."id", m."kind", m."title", m."durationMs", m."width", m."height",
                    m."addedAt", m."capturedAt", m."probedAt", m."codec", m."container",
                    m."bitrate", m."fps", m."videoProfile", m."pixFmt", m."audioCodec",
                    f."size" AS "sizeBytes", f."relPath", f."rootId",
                    r."label" AS "rootLabel", r."writable" AS "rootWritable",
                    ${COVER_SELECTION},
                    spriteVtt."relPath" AS "spriteVttPath",
                    spriteVtt."generatedAt" AS "spriteVttGeneratedAt",
                    um."rating", um."favorite", um."hidden", um."watchedAt",
                    um."note"
             ${BASE_FROM}
             ${ORIGINAL_FILE_JOIN}
             JOIN "MediaRoot" r ON r."id" = f."rootId"
             LEFT JOIN "Artifact" spriteVtt ON spriteVtt."mediaId" = m."id"
                                           AND spriteVtt."kind" = 'spriteVtt'
                                           AND spriteVtt."ordinal" = 0
              WHERE m."id" = :mediaId
                AND f."state" = 'active'
                AND f."rootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})`
        )
        .get({ mediaId, userId, ...rootParams }) as MediaDetailRow | undefined;
};

/** Which artifact the art route wants: the item's effective cover, or one named row. */
export type ArtifactTarget =
    { effectiveCover: true } | { effectiveCover: false; kind: ArtifactKind; ordinal: number };

/**
 * An item's artifact, if someone who can see these roots may see the item — in one statement.
 *
 * The art route asks this once per grid tile, sixty to a page, on the thread that serves every
 * other request. It used to be two statements, a visibility check and then the artifact row,
 * and before that `findDetail`'s nine probes: each one a chance at a page-cache miss on a disk
 * ffmpeg is also reading, and on one thread every tile waits for the slowest (§20). The
 * visibility conditions must stay those of `findDetail`, or a tile would draw for an item its
 * detail page reports as missing.
 *
 * "Not visible" and "no such artifact" both come back undefined, deliberately: a viewer must
 * not be able to tell an item they cannot open from one that does not exist.
 *
 * `includeTrashed` also sees an item in the bin, for the trash page (§10), which is
 * admin-only. Artifacts are kept until purge precisely so the bin can be looked at rather
 * than guessed at, and without this every cover on that page was a broken image. Nobody else
 * gets it: to them a trashed item has left the library, and a cover would say otherwise.
 */
export const findVisibleArtifact = (
    mediaId: string,
    rootIds: string[],
    target: ArtifactTarget,
    options: { includeTrashed?: boolean } = {}
): ArtifactRow | undefined => {
    if (rootIds.length === 0) {
        return undefined;
    }

    const rootParams = Object.fromEntries(rootIds.map((id, i) => [`root${i}`, id]));

    // The effective cover is the chosen one when there is a choice, else the generated
    // ordinal-0 cover — the same rule as `artifactRepo.findEffectiveCover`.
    const artifactJoin = target.effectiveCover
        ? `LEFT JOIN "Artifact" generated ON generated."mediaId" = m."id"
                                          AND generated."kind" = 'cover'
                                          AND generated."ordinal" = 0
           JOIN "Artifact" a ON a."id" = COALESCE(m."coverArtifactId", generated."id")`
        : `JOIN "Artifact" a ON a."mediaId" = m."id"
                            AND a."kind" = :kind
                            AND a."ordinal" = :ordinal`;

    return db
        .prepare(
            `SELECT a."id", a."mediaId", a."kind", a."ordinal", a."relPath", a."width",
                    a."height", a."tileCount", a."intervalMs", a."bytes", a."atMs", a."source",
                    a."createdByUserId", a."label", a."generatorVersion", a."generatedAt"
               FROM "Media" m
               ${ORIGINAL_FILE_JOIN}
               ${artifactJoin}
              WHERE m."id" = :mediaId
                AND (f."state" = 'active' OR (:trashed = 1 AND f."state" = 'trashed'))
                AND f."rootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})`
        )
        .get({
            mediaId,
            trashed: options.includeTrashed ? 1 : 0,
            ...rootParams,
            ...(target.effectiveCover ? {} : { kind: target.kind, ordinal: target.ordinal }),
        }) as ArtifactRow | undefined;
};

/**
 * How much of the library this viewer can actually open, for the navigation counts (§14).
 *
 * It counts the same population `countMedia` does — `listable`, not hidden, in an accessible
 * root — because the number sits beside a grid the viewer is about to scroll. Counting `Media`
 * instead reported items whose only file is archived or trashed: a library that promised ten
 * and delivered five, with nothing on screen to explain the other five and no way to reach
 * them. The breakdown by kind is one grouped pass rather than three filtered counts, because
 * an exact count is a scan of the matching set (§20) and the nav asks for all three at once.
 *
 * Not expressed through `buildFilters`: that builds a *query*, and everything it adds beyond
 * these three predicates — search, tags, ratings, the overlay — is something the nav never
 * asks about, so routing through it would cost a `MediaQuery` this caller has to invent.
 */
export const countVisible = (
    userId: string,
    rootIds: string[]
): { total: number; videos: number; images: number } => {
    if (rootIds.length === 0) {
        // No accessible roots must count nothing, not everything.
        return { total: 0, videos: 0, images: 0 };
    }

    const rootParams = Object.fromEntries(rootIds.map((id, i) => [`root${i}`, id]));

    return db
        .prepare(
            // COALESCE because sum() over no rows is NULL, not 0 -- an empty library would
            // otherwise report null counts where the UI expects a number.
            `SELECT count(*) AS "total",
                    COALESCE(sum(CASE WHEN m."kind" = 'video' THEN 1 ELSE 0 END), 0) AS "videos",
                    COALESCE(sum(CASE WHEN m."kind" = 'image' THEN 1 ELSE 0 END), 0) AS "images"
             ${COUNT_FROM}
              WHERE m."listable" = 1
                AND um."hidden" IS NULL
                AND m."listRootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})`
        )
        .get({ userId, ...rootParams }) as { total: number; videos: number; images: number };
};

/**
 * The population every stage is measured against (§13c).
 *
 * The *denominator* for the numerator `mediaIdsNeedingStage` produces, so it must select the
 * same items. Counting a wider set — items whose file was trashed, or whose classification says
 * it is a sidecar rather than media — gives a bar that can never reach its own end, because the
 * sweep will never select the difference. Both start from `listable = 1`, the trigger-maintained
 * form of "the original file is active and media"; a test asserts the two agree.
 *
 * It used to spell that condition out as a join of every item to its link and file: ~3,450
 * pages on the real library, 4 s on the NAS. `idx_Media_listable_probed_kind` holds exactly the
 * two columns this splits by, so the count reads ~50 pages of index and no row. Grouped rather
 * than summed with `CASE`: a `CASE` that tests `probedAt` does not match the indexed expression,
 * and the plan goes back to reading every row.
 *
 * The probed counts are the population of a stage that waits on the probe (`needsProbe`): the
 * sweep never selects an item the probe has not read, so measuring those stages against every
 * item would leave each bar short of its end by exactly the files that cannot be read.
 */
export const countProcessable = (): {
    image: number;
    video: number;
    probedImage: number;
    probedVideo: number;
} => {
    const rows = db
        .prepare(
            `SELECT "kind", "probedAt" IS NOT NULL AS "probed", count(*) AS "count"
               FROM "Media" INDEXED BY "idx_Media_listable_probed_kind"
              WHERE "listable" = 1
              GROUP BY "probedAt" IS NOT NULL, "kind"`
        )
        .all() as { kind: string; probed: 0 | 1; count: number }[];
    const counts = { image: 0, video: 0, probedImage: 0, probedVideo: 0 };

    for (const row of rows) {
        const kind = row.kind === "image" ? "image" : "video";

        counts[kind] += row.count;

        if (row.probed === 1) {
            counts[kind === "image" ? "probedImage" : "probedVideo"] += row.count;
        }
    }

    return counts;
};

export interface FacetCountRow {
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    count: number;
}

/**
 * Which of the two tagging systems a facet query counts in (§6).
 *
 * Public counts library assignments only, so the number against a shared chip is the same for
 * everybody. Private counts the viewer's own. They used to be ORed together, which made a
 * public tag's count the viewer's own total — two people seeing different numbers against one
 * chip, and no way to say which was right.
 *
 * Written once and passed in, because the same predicate appears in three queries that have to
 * agree: the counts, the counts for already-selected tags, and the totals behind "show all".
 */
export type FacetScope = "public" | "private";

const SCOPE_PREDICATE: Record<FacetScope, string> = {
    public: `mt."userId" IS NULL`,
    private: `mt."userId" = :userId`,
};

/**
 * The same question asked of the **tag** rather than of an assignment of it.
 *
 * Needed wherever a query starts from `Tag` instead of `MediaTag`. The two systems pair
 * exactly — a tag with an owner is only ever assigned to that owner (§6) — so the two
 * predicates select the same tags by two different routes, and mixing them up is how a
 * selected private tag ends up listed in the public pass with a count of zero.
 */
const OWNER_PREDICATE: Record<FacetScope, string> = {
    public: `t."ownerId" IS NULL`,
    private: `t."ownerId" = :userId`,
};

/**
 * Counts for a named set of tags under the current filter (§5c, §20).
 *
 * **The only facet counter, and it counts exactly.** It used to be the exception -- the
 * uncapped path that kept a selected chip from vanishing -- beside a `facetCounts` that
 * discovered values by scanning the filtered library and therefore had to stop at a sample.
 * That pairing is gone: the values come from the vocabulary now
 * (`tagRepo.listFacetValues`), and this counts the ones about to be drawn.
 *
 * What makes an exact count affordable is the direction of the query. It asks, per tag,
 * "how many of *your* assignments survive the filter" -- driven from `idx_MediaTag_tagId`,
 * which covers the scope and the item so no `MediaTag` row is read, then one primary-key
 * probe per assignment. The cost is the tagging, not the library, so it does
 * not grow with the 200k items the cap was there to protect against. Asked the other way
 * round -- build the filtered set, then group the tags in it -- the library is the cost and
 * a cap is the only answer.
 *
 * Hence `EXISTS` rather than `mediaId IN (SELECT ...)`. The `IN` form materialises the whole
 * filtered set once per request before any tag is counted, which is the scan being avoided;
 * correlating on `m."id"` lets the planner start from the assignments instead.
 *
 * The count can legitimately be zero: with AND semantics a filter can exclude everything a
 * tag is on, and showing "Noir (0)" is how someone understands why the grid is empty and
 * what to click to fix it.
 */
export const facetCountsForTags = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    tagIds: string[],
    scope: FacetScope,
    /** Whose ratings the query asks about, exactly as for `listMedia` (§6). */
    overlayUserId?: string
): FacetCountRow[] => {
    if (tagIds.length === 0) {
        return [];
    }

    const { where, params } = buildFilters(query, userId, rootIds, overlayUserId);
    const FROM = fromClause(query, params);
    const placeholders = tagIds.map((_, i) => `:wanted${i}`).join(", ");

    tagIds.forEach((tagId, i) => {
        params[`wanted${i}`] = tagId;
    });

    return db
        .prepare(
            `SELECT t."id" AS "tagId", t."kind", t."name", t."colorKey",
                    (
                        SELECT count(*) FROM "MediaTag" mt
                         WHERE mt."tagId" = t."id"
                           AND ${SCOPE_PREDICATE[scope]}
                           AND EXISTS (
                               SELECT 1 ${FROM}
                                WHERE ${where.join(" AND ")} AND m."id" = mt."mediaId"
                           )
                    ) AS "count"
               FROM "Tag" t
              -- Scoped on the *tag*, not only on its assignments. Filtering the count alone
              -- returned every selected id in both passes, differing only by a zero -- which
              -- is how a private tag appeared under the public heading (§6).
              WHERE t."id" IN (${placeholders}) AND ${OWNER_PREDICATE[scope]}`
        )
        .all(params) as FacetCountRow[];
};

/**
 * The filter panel's Favourites chip for one facet: how many favourite tags of it somebody has
 * (§14e "Favourites ♥"). Null when they have none, which is the panel's cue to leave the chip
 * out.
 */
export const favoriteTagCount = (userId: string, kind: string): { tags: number } | null => {
    const { tags } = db
        .prepare(
            `SELECT count(*) AS "tags" FROM "UserTag" ut
               JOIN "Tag" t ON t."id" = ut."tagId" AND t."kind" = ?
                    AND (t."ownerId" IS NULL OR t."ownerId" = ?)
              WHERE ut."userId" = ? AND ut."favorite" IS NOT NULL`
        )
        .get(kind, userId, userId) as { tags: number };

    return tags === 0 ? null : { tags };
};

/**
 * Hydrates a known set of items, in the order asked for.
 *
 * For lists whose membership is decided elsewhere — a playlist, a shelf — where the order is
 * the caller's and not a sort over the library. Everything else the grid guarantees still
 * holds: `listable`, the viewer's accessible roots, and their hidden items are all applied
 * here rather than trusted to the caller.
 *
 * An id that fails any of those simply does not come back. That is deliberate and is not a
 * deletion: a playlist keeps its entry for an item on an unmounted library, and the entry
 * reappears when the library does (§12b).
 */
export const listByIds = (ids: string[], userId: string, rootIds: string[]): MediaListRow[] => {
    if (ids.length === 0 || rootIds.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { userId, ids: JSON.stringify(ids) };
    const rootPlaceholders = rootIds.map((_, i) => `:root${i}`).join(", ");

    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    // Driven from the ids, and the CROSS JOIN is what keeps it so. Written as a filter on
    // `Media`, the planner took the root clause as its way in and walked every listable item in
    // an `idx_Media_list_*` index to find the dozen asked for -- 315 pages on the production
    // replica, growing with the library, for a playlist shelf or a lookup of the tiles on
    // screen (§20). SQLite never reorders a CROSS JOIN, so this is one primary-key probe per id.
    const rows = db
        .prepare(
            `${SELECTION}
               FROM json_each(:ids) wanted
              CROSS JOIN "Media" m ON m."id" = wanted."value"
               LEFT JOIN "UserMedia" um ON um."mediaId" = m."id" AND um."userId" = :userId
              ${TILE_JOINS}
              WHERE m."listable" = 1
                AND um."hidden" IS NULL
                AND m."listRootId" IN (${rootPlaceholders})`
        )
        .all(params) as MediaListRow[];

    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids.map((id) => byId.get(id)).filter((row): row is MediaListRow => row !== undefined);
};

/**
 * Items this viewer has viewed, most recent first (§6).
 *
 * Its own query rather than the grid's `lastViewed` sort, because it is a walk of one user's
 * small overlay table: the partial index on `UserMedia(userId, lastViewedAt) WHERE lastViewedAt
 * IS NOT NULL` makes it a handful of index steps regardless of how large the library is.
 *
 * **Driven from `UserMedia`, and the `CROSS JOIN` is what says so.** It used to be the grid's
 * `FROM "Media" m LEFT JOIN "UserMedia" um`, and with no statistics the planner kept `Media` as
 * the outer loop: it walked every listable item through a `listRootId` index, read each one's
 * full row, probed the overlay and the four tile joins for all of them, and sorted the
 * survivors — 2,036 pages for twelve rows on the production replica, and the 32-second
 * statement behind a 43-second `/api/home` after a restart (§20). SQLite never reorders a
 * `CROSS JOIN`, so the walk is `idx_UserMedia_viewed` newest first, a primary-key probe per
 * candidate, and it stops at the limit with no sort.
 */
export const listRecentlyViewed = (
    userId: string,
    rootIds: string[],
    limit: number
): MediaListRow[] => {
    if (rootIds.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { userId, limit };
    const rootPlaceholders = rootIds.map((_, i) => `:root${i}`).join(", ");

    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    return db
        .prepare(
            `${SELECTION}
               FROM "UserMedia" um
              CROSS JOIN "Media" m ON m."id" = um."mediaId"
              ${TILE_JOINS}
              WHERE um."userId" = :userId
                AND um."lastViewedAt" IS NOT NULL
                AND um."hidden" IS NULL
                AND m."listable" = 1
                AND m."listRootId" IN (${rootPlaceholders})
              ORDER BY um."lastViewedAt" DESC
              LIMIT :limit`
        )
        .all(params) as MediaListRow[];
};

/**
 * Just the ids matching a query, up to a cap.
 *
 * For acting on a filtered set rather than displaying it (§5d). Ids only, because the caller
 * is about to write to each one and has no use for cover URLs or ratings — and because a
 * bulk operation's working set has to fit in memory where a page of the grid does not.
 *
 * The cap is the caller's, and hitting it is the caller's problem to report: silently acting
 * on the first ten thousand of a larger set is the failure mode this exists to prevent.
 */
export const listMediaIds = (
    query: MediaQuery,
    userId: string,
    rootIds: string[],
    cap: number,
    overlayUserId?: string
): string[] => {
    const { where, params, source } = buildFilters(query, userId, rootIds, overlayUserId, {
        drive: true,
    });

    return (
        db
            .prepare(
                `SELECT m."id" ${withOverlay(
                    // Relevance resolves its match through the FTS join; every other sort
                    // filters through the subquery and needs nothing beyond the minimal FROM.
                    query.sort === "relevance" && params.match !== undefined
                        ? `${countFrom(source)} ${searchRepo.MATCH_JOIN_SQL}`
                        : countFrom(source),
                    params
                )}
                  WHERE ${where.join(" AND ")}
                  LIMIT :cap`
            )
            .all({ ...params, cap }) as { id: string }[]
    ).map((row) => row.id);
};
