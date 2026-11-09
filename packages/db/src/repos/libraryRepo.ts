import type {
    FilterGroup,
    FilterMeasure,
    FilterRule,
    LibraryQuery,
    MediaSort,
} from "@private-stock/core";

import { db } from "../db.js";
import { notHiddenSql } from "./hiddenSql.js";
import { anyTagSql } from "./tagSql.js";

/**
 * Your clips and captures, filtered by the library's own query (§14e "What a kind is").
 *
 * The library's filters were written about items. Here each is read as a clip or a capture can
 * answer it, in one of three ways:
 *
 *  - **its own fact**: a clip's tags, stars, heart and run time; either one's name and the day it
 *    was made;
 *  - **its video's fact**: the library, the file's measures, when the video was captured -- and,
 *    for a capture, which has no tags of its own, the video's tags;
 *  - **nothing it can answer**: watched, review passes, a look, "mentions", animated -- and, for a
 *    capture, stars, heart and run time. Such a filter leaves that kind out of the list, rather
 *    than being quietly ignored for it (§14e "A filter that cannot apply is absent").
 *
 * The rows are a person's own, and a person has hundreds of each, so the whole matching set is
 * read with its sort key and ordered by the caller -- which is what lets All merge them into the
 * library's own walk (`libraryMerge`). Always the viewer's own, `listable`, in libraries they can
 * reach and not hidden, as `/clips` and `/captures` read them.
 */

export type SmallType = "clip" | "capture";

export interface SmallKeyRow {
    type: SmallType;
    id: string;
    /** The sort key, as SQLite would compare it: NULL, a number, or text. */
    k: number | string | null;
}

interface Scope {
    userId: string;
    accessibleRootIds: string[] | null;
}

/** How one kind answers the library's questions, as SQL over its own alias and its video's `m`. */
interface KindSql {
    type: SmallType;
    from: string;
    owner: string;
    mediaId: string;
    /** The kind carries the tag itself (or, for a capture, through its video). */
    tagPick: (placeholder: string, orVideo: boolean) => string;
    /** No tag of this facet, the same way round. */
    untagged: (kindParam: string) => string;
    /** Any of the viewer's favourite tags of a facet. */
    favTags: (kindParam: string) => string;
    rating: string | null;
    favorite: string | null;
    runMs: string | null;
    added: string;
    name: string;
    search: (param: string) => string;
    /** The picture's own sides, for orientation; the video's for a clip. */
    width: string;
    height: string;
    unused: string | null;
}

const RUN_MS = `CAST(ROUND((c."endMs" - c."startMs") / COALESCE(c."speed", 1.0)) AS INTEGER)`;

const clipTagSql = (placeholder: string): string =>
    `EXISTS (SELECT 1 FROM "ClipTag" ct WHERE ct."clipId" = c."id" AND ct."tagId" = ${placeholder})`;

const favoriteOn = (from: string, owner: string, kindParam: string, visible: string): string =>
    `EXISTS (SELECT 1 FROM ${from}
               JOIN "UserTag" fut ON fut."tagId" = ${owner}."tagId"
                    AND fut."userId" = :userId AND fut."favorite" IS NOT NULL
               JOIN "Tag" ft ON ft."id" = ${owner}."tagId" AND ft."kind" = :${kindParam}
                    AND (ft."ownerId" IS NULL OR ft."ownerId" = :userId)
              WHERE ${visible})`;

const videoTagsAbsent = (mediaId: string, kindParam: string): string =>
    `NOT EXISTS (SELECT 1 FROM "MediaTag" umt
                   JOIN "Tag" ut ON ut."id" = umt."tagId" AND ut."kind" = :${kindParam}
                  WHERE umt."mediaId" = ${mediaId}
                    AND (umt."userId" IS NULL OR umt."userId" = :userId))`;

const CLIP: KindSql = {
    type: "clip",
    from: `"Clip" c JOIN "Media" m ON m."id" = c."mediaId"`,
    owner: `c."userId"`,
    mediaId: `c."mediaId"`,
    tagPick: (placeholder, orVideo) =>
        orVideo
            ? `(${clipTagSql(placeholder)} OR ${anyTagSql([placeholder], `c."mediaId"`)})`
            : clipTagSql(placeholder),
    untagged: (kindParam) =>
        `NOT EXISTS (SELECT 1 FROM "ClipTag" uct
                       JOIN "Tag" ut ON ut."id" = uct."tagId" AND ut."kind" = :${kindParam}
                      WHERE uct."clipId" = c."id")`,
    favTags: (kindParam) => favoriteOn(`"ClipTag" fct`, "fct", kindParam, `fct."clipId" = c."id"`),
    rating: `c."rating"`,
    favorite: `c."favorite"`,
    runMs: RUN_MS,
    added: `c."createdAt"`,
    name: `COALESCE(c."label", m."title")`,
    search: (param) => `c."label" LIKE :${param} ESCAPE '\\'`,
    width: `m."width"`,
    height: `m."height"`,
    unused: `NOT EXISTS (SELECT 1 FROM "ReelItem" ri WHERE ri."clipId" = c."id")`,
};

const CAPTURE: KindSql = {
    type: "capture",
    // `kind = 'capture'` as a literal, so `idx_Artifact_capture_owner` qualifies.
    from: `"Artifact" a JOIN "Media" m ON m."id" = a."mediaId"`,
    owner: `a."createdByUserId"`,
    mediaId: `a."mediaId"`,
    tagPick: (placeholder) => anyTagSql([placeholder], `a."mediaId"`),
    untagged: (kindParam) => videoTagsAbsent(`a."mediaId"`, kindParam),
    favTags: (kindParam) =>
        favoriteOn(
            `"MediaTag" fmt`,
            "fmt",
            kindParam,
            `fmt."mediaId" = a."mediaId" AND (fmt."userId" IS NULL OR fmt."userId" = :userId)`
        ),
    rating: null,
    favorite: null,
    runMs: null,
    added: `a."generatedAt"`,
    name: `COALESCE(a."label", m."title")`,
    search: (param) =>
        `(a."label" LIKE :${param} ESCAPE '\\' OR m."title" LIKE :${param} ESCAPE '\\')`,
    width: `a."width"`,
    height: `a."height"`,
    unused: null,
};

/** A file's measures, read from the video for both kinds; run time is the clip's own. */
const VIDEO_MEASURE: Record<
    Exclude<FilterMeasure, "durationSec">,
    { column: string; scale: number }
> = {
    bitrateKbps: { column: `m."bitrate"`, scale: 1_000 },
    fps: { column: `m."fps"`, scale: 1 },
    resolution: { column: `MIN(m."width", m."height")`, scale: 1 },
    sizeMb: { column: `m."listSize"`, scale: 1_024 * 1_024 },
};

const ORIENTATION = (kind: KindSql, value: "landscape" | "portrait" | "square"): string => {
    const { width, height } = kind;

    if (value === "landscape") return `${width} > ${height}`;
    if (value === "portrait") return `${width} < ${height}`;

    return `${width} = ${height}`;
};

/** A filter this kind cannot answer: the condition that excludes it. */
const NEVER = "0";

class Builder {
    readonly clauses: string[] = [];
    readonly params: Record<string, unknown> = {};
    private next = 0;

    constructor(readonly kind: KindSql) {}

    bind(value: unknown): string {
        const name = `p${this.next++}`;

        this.params[name] = value;

        return name;
    }

    range(
        column: string,
        min: number | undefined,
        max: number | undefined,
        scale: number
    ): string[] {
        const parts: string[] = [];

        if (min !== undefined) parts.push(`${column} >= :${this.bind(min * scale)}`);
        if (max !== undefined) parts.push(`${column} < :${this.bind(max * scale)}`);

        return parts;
    }

    measure(measure: FilterMeasure, min: number | undefined, max: number | undefined): string[] {
        if (min === undefined && max === undefined) return [];

        if (measure === "durationSec") {
            return this.kind.runMs === null
                ? [NEVER]
                : this.range(this.kind.runMs, min, max, 1_000);
        }

        const { column, scale } = VIDEO_MEASURE[measure];

        return this.range(column, min, max, scale);
    }

    rating(min: number | undefined, max: number | undefined): string[] {
        if (this.kind.rating === null) return [NEVER];

        const parts: string[] = [];

        if (min !== undefined) parts.push(`${this.kind.rating} >= :${this.bind(min)}`);
        if (max !== undefined) parts.push(`${this.kind.rating} <= :${this.bind(max)}`);

        return parts;
    }

    rule(rule: FilterRule): string {
        switch (rule.t) {
            case "tag":
                return this.kind.tagPick(`:${this.bind(rule.id)}`, false);
            case "favTags":
                return this.kind.favTags(this.bind(rule.kind));
            case "untagged":
                return this.kind.untagged(this.bind(rule.kind));
            case "favorite":
                return this.kind.favorite === null ? NEVER : `${this.kind.favorite} = 1`;
            case "unrated":
                return this.kind.rating === null ? NEVER : `${this.kind.rating} IS NULL`;
            case "rating":
                return this.rating(rule.min, rule.max).join(" AND ") || "1";
            case "measure":
                return this.measure(rule.measure, rule.min, rule.max).join(" AND ") || "1";
            case "orientation":
                return ORIENTATION(this.kind, rule.value);
            case "root":
                return `m."listRootId" = :${this.bind(rule.id)}`;
            // A clip or a capture is neither watched, animated, nor an item of a kind.
            case "watched":
            case "animated":
            case "kind":
                return NEVER;
        }
    }

    group(group: FilterGroup): string {
        const conditions = group.rules.map((rule) => `(${this.rule(rule)})`);

        if (group.match === "all") return `(${conditions.join(" AND ")})`;
        if (group.match === "any") return `(${conditions.join(" OR ")})`;

        return `NOT (${conditions.map((condition) => `coalesce(${condition}, 0)`).join(" OR ")})`;
    }
}

const likeTerm = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/** The WHERE for one kind, or null when the query asks something it cannot answer at all. */
const whereFor = (kind: KindSql, query: LibraryQuery, scope: Scope): Builder | null => {
    if (
        query.mentions ||
        query.lookText ||
        query.like ||
        query.watched ||
        query.reviewedFor?.length ||
        query.notReviewedFor?.length ||
        query.playback ||
        query.animated ||
        (query.unusedOnly && kind.unused === null)
    ) {
        return null;
    }

    const b = new Builder(kind);
    const { clauses } = b;

    b.params.userId = scope.userId;
    clauses.push(`${kind.owner} = :userId`, `m."listable" = 1`, notHiddenSql(kind.mediaId));

    if (kind.type === "capture") {
        clauses.push(`a."kind" = 'capture'`);
    }

    if (scope.accessibleRootIds !== null) {
        if (scope.accessibleRootIds.length === 0) return null;

        clauses.push(
            `m."listRootId" IN (${scope.accessibleRootIds.map((id) => `:${b.bind(id)}`).join(", ")})`
        );
    }

    if (query.rootId) clauses.push(`m."listRootId" = :${b.bind(query.rootId)}`);
    if (query.search) clauses.push(kind.search(b.bind(likeTerm(query.search))));

    const orVideo = new Set(query.orVideo ?? []);

    for (const id of query.tags ?? []) {
        clauses.push(kind.tagPick(`:${b.bind(id)}`, orVideo.has(id)));
    }

    for (const id of query.notTags ?? []) {
        clauses.push(`NOT ${kind.tagPick(`:${b.bind(id)}`, orVideo.has(id))}`);
    }

    if (query.favorite) {
        clauses.push(kind.favorite === null ? NEVER : `${kind.favorite} = 1`);
    }

    if (query.unrated) {
        clauses.push(kind.rating === null ? NEVER : `${kind.rating} IS NULL`);
    }

    if (query.minRating !== undefined || query.maxRating !== undefined) {
        clauses.push(...b.rating(query.minRating, query.maxRating));
    }

    clauses.push(
        ...b.measure("durationSec", query.minDurationSec, query.maxDurationSec),
        ...b.measure("bitrateKbps", query.minBitrateKbps, query.maxBitrateKbps),
        ...b.measure("fps", query.minFps, query.maxFps),
        ...b.measure("resolution", query.minResolution, query.maxResolution),
        ...b.measure("sizeMb", query.minSizeMb, query.maxSizeMb)
    );

    if (query.orientation) clauses.push(ORIENTATION(kind, query.orientation));

    // Whole days at both ends, as the library reads its own (§14e "Dates").
    if (query.addedFrom) clauses.push(`${kind.added} >= :${b.bind(query.addedFrom)}`);
    if (query.addedTo) clauses.push(`${kind.added} < date(:${b.bind(query.addedTo)}, '+1 day')`);
    if (query.capturedFrom) clauses.push(`m."capturedAt" >= :${b.bind(query.capturedFrom)}`);
    if (query.capturedTo) {
        clauses.push(`m."capturedAt" < date(:${b.bind(query.capturedTo)}, '+1 day')`);
    }

    if (query.unusedOnly && kind.unused !== null) clauses.push(kind.unused);

    for (const group of query.groups ?? []) {
        clauses.push(b.group(group));
    }

    return b;
};

/** The key each kind sorts by, for the sorts every kind can answer. */
const keyFor = (kind: KindSql, sort: MediaSort): string => {
    switch (sort) {
        case "title":
            return kind.name;
        case "duration":
            return kind.runMs ?? "NULL";
        case "rating":
            return kind.rating ?? "NULL";
        default:
            // Date added, and the stand-in for the orders the caller keys itself (shuffle,
            // relevance) or does not offer here.
            return kind.added;
    }
};

const smallKeysOf = (
    kind: KindSql,
    query: LibraryQuery,
    scope: Scope,
    sort: MediaSort
): SmallKeyRow[] => {
    const b = whereFor(kind, query, scope);

    if (b === null) return [];

    const alias = kind.type === "clip" ? "c" : "a";

    return (
        db
            .prepare(
                `SELECT ${alias}."id" AS "id", ${keyFor(kind, sort)} AS "k"
                   FROM ${kind.from}
                  WHERE ${b.clauses.join(" AND ")}`
            )
            .all(b.params) as { id: string; k: number | string | null }[]
    ).map((row) => ({ type: kind.type, id: row.id, k: row.k }));
};

/**
 * Every clip and capture of the viewer's that the query matches, with its sort key, unordered.
 *
 * `types` says which kinds the tab lists. The caller orders them, by the same rule it uses to
 * merge them with the library's items.
 */
export const smallKeys = (
    query: LibraryQuery,
    scope: Scope,
    sort: MediaSort,
    types: readonly SmallType[]
): SmallKeyRow[] => [
    ...(types.includes("clip") ? smallKeysOf(CLIP, query, scope, sort) : []),
    ...(types.includes("capture") ? smallKeysOf(CAPTURE, query, scope, sort) : []),
];
