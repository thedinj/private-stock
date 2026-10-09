import { randomUUID } from "node:crypto";

import type { COVER_CLEARED_CHANGE, CaptureQuery, CaptureSort } from "@private-stock/core";

import { db } from "../db.js";
import * as changeLogRepo from "./changeLogRepo.js";
import { notHiddenSql } from "./hiddenSql.js";

/**
 * Generated imagery: covers, alternates, user captures, previews, sprite sheets (§9).
 *
 * **Rows hold paths; bytes live on disk.** Sprite sheets for a 200k-item library run to tens
 * of gigabytes — in SQLite that bloats every backup, makes `VACUUM INTO` impractical, and
 * forces reads through the same write-locked file the worker is hammering.
 *
 * The distinction this repo exists to protect is `source`. An `auto` artifact is disposable
 * output that a changed recipe may replace at any time; a `user` artifact is something a
 * person made. Every write here is explicit about which it is producing, so regeneration
 * cannot quietly destroy someone's work.
 */

export type ArtifactKind =
    "cover" | "poster" | "capture" | "preview" | "sprite" | "spriteVtt" | "subtitleVtt";

export type ArtifactSource = "auto" | "user";

export interface ArtifactRow {
    id: string;
    mediaId: string;
    kind: ArtifactKind;
    ordinal: number;
    relPath: string;
    width: number | null;
    height: number | null;
    tileCount: number | null;
    intervalMs: number | null;
    bytes: number | null;
    atMs: number | null;
    source: ArtifactSource;
    createdByUserId: string | null;
    label: string | null;
    generatorVersion: number;
    generatedAt: string;
}

export interface UpsertArtifactInput {
    mediaId: string;
    kind: ArtifactKind;
    ordinal?: number;
    relPath: string;
    width?: number | null;
    height?: number | null;
    tileCount?: number | null;
    intervalMs?: number | null;
    bytes?: number | null;
    atMs?: number | null;
    source?: ArtifactSource;
    createdByUserId?: string | null;
    label?: string | null;
    generatorVersion?: number;
}

const SELECT_COLUMNS = `"id", "mediaId", "kind", "ordinal", "relPath", "width", "height",
                        "tileCount", "intervalMs", "bytes", "atMs", "source",
                        "createdByUserId", "label", "generatorVersion", "generatedAt"`;

/**
 * Insert or replace one artifact, keyed by `(mediaId, kind, ordinal)`.
 *
 * `ON CONFLICT DO UPDATE` rather than delete-then-insert, so the id is stable.
 * `Media.coverArtifactId` points at it, and regenerating a cover someone had chosen must not
 * silently clear their choice by making the row a different one.
 */
export const upsert = (input: UpsertArtifactInput): ArtifactRow =>
    db
        .prepare(
            `INSERT INTO "Artifact"
                ("id", "mediaId", "kind", "ordinal", "relPath", "width", "height", "tileCount",
                 "intervalMs", "bytes", "atMs", "source", "createdByUserId", "label",
                 "generatorVersion", "generatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT ("mediaId", "kind", "ordinal") DO UPDATE SET
                "relPath" = excluded."relPath",
                "width" = excluded."width",
                "height" = excluded."height",
                "tileCount" = excluded."tileCount",
                "intervalMs" = excluded."intervalMs",
                "bytes" = excluded."bytes",
                "atMs" = excluded."atMs",
                "source" = excluded."source",
                "createdByUserId" = excluded."createdByUserId",
                "label" = excluded."label",
                "generatorVersion" = excluded."generatorVersion",
                "generatedAt" = CURRENT_TIMESTAMP
             RETURNING ${SELECT_COLUMNS}`
        )
        .get(
            randomUUID(),
            input.mediaId,
            input.kind,
            input.ordinal ?? 0,
            input.relPath,
            input.width ?? null,
            input.height ?? null,
            input.tileCount ?? null,
            input.intervalMs ?? null,
            input.bytes ?? null,
            input.atMs ?? null,
            input.source ?? "auto",
            input.createdByUserId ?? null,
            input.label?.slice(0, 200) ?? null,
            input.generatorVersion ?? 1
        ) as ArtifactRow;

export const findById = (id: string): ArtifactRow | undefined =>
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM "Artifact" WHERE "id" = ?`).get(id) as
        ArtifactRow | undefined;

export const findOne = (
    mediaId: string,
    kind: ArtifactKind,
    ordinal = 0
): ArtifactRow | undefined =>
    db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "Artifact"
              WHERE "mediaId" = ? AND "kind" = ? AND "ordinal" = ?`
        )
        .get(mediaId, kind, ordinal) as ArtifactRow | undefined;

export const listForMedia = (mediaId: string, kinds?: ArtifactKind[]): ArtifactRow[] => {
    if (kinds && kinds.length === 0) {
        return [];
    }

    const kindClause = kinds ? ` AND "kind" IN (${kinds.map(() => "?").join(", ")})` : "";

    return db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "Artifact"
              WHERE "mediaId" = ?${kindClause}
              ORDER BY "kind" ASC, "ordinal" ASC`
        )
        .all(mediaId, ...(kinds ?? [])) as ArtifactRow[];
};

/**
 * Resolve the image that represents this media.
 *
 * `Media.coverArtifactId` wins when it is set, because it is a deliberate choice — possibly
 * of a user capture, possibly of one of the generated alternates. Falling back to the
 * ordinal-0 cover means an item nobody has curated still has a picture.
 */
export const findEffectiveCover = (mediaId: string): ArtifactRow | undefined =>
    db
        .prepare(
            `SELECT a."id", a."mediaId", a."kind", a."ordinal", a."relPath", a."width",
                    a."height", a."tileCount", a."intervalMs", a."bytes", a."atMs", a."source",
                    a."createdByUserId", a."label", a."generatorVersion", a."generatedAt"
               FROM "Media" m
               LEFT JOIN "Artifact" generated ON generated."mediaId" = m."id"
                                             AND generated."kind" = 'cover'
                                             AND generated."ordinal" = 0
               JOIN "Artifact" a ON a."id" = COALESCE(m."coverArtifactId", generated."id")
              WHERE m."id" = ?`
        )
        .get(mediaId) as ArtifactRow | undefined;

/**
 * The cover somebody chose, or null when nobody has.
 *
 * Distinct from `findEffectiveCover`, which always answers with a picture: this answers
 * whether a *decision* has been made. The two are different questions and the difference
 * decides whether a curated choice may be replaced automatically (§13).
 */
export const findChosenCover = (mediaId: string): string | null =>
    (
        db
            .prepare(
                /**
                 * A pointer at the generated cover is not a choice, and reads as none.
                 *
                 * Normalised on the way out as well as on the way in, because rows already
                 * hold one: the strip used to store an explicit pointer when somebody clicked
                 * the generated frame, which looks identical on screen and silently disabled
                 * the first-capture promotion for the life of the item. Answering the question
                 * correctly repairs those without a migration.
                 */
                `SELECT m."coverArtifactId" AS "chosen"
                   FROM "Media" m
                   LEFT JOIN "Artifact" a ON a."id" = m."coverArtifactId"
                  WHERE m."id" = ?
                    AND COALESCE(a."kind" != 'cover' OR a."ordinal" != 0, 1)`
            )
            .get(mediaId) as { chosen: string | null } | undefined
    )?.chosen ?? null;

export interface MissingArtifactRow {
    id: string;
    fileId: string;
}

/**
 * Point a media item at a specific artifact as its cover.
 *
 * Passing `null` reverts to the generated one. The artifact is checked to belong to this
 * media: an id from another item would otherwise be accepted and quietly serve the wrong
 * picture.
 */
export const setCoverArtifact = (mediaId: string, artifactId: string | null): boolean => {
    if (artifactId !== null) {
        const owns = db
            .prepare(`SELECT 1 FROM "Artifact" WHERE "id" = ? AND "mediaId" = ?`)
            .get(artifactId, mediaId);

        if (!owns) {
            return false;
        }
    }

    const result = db
        .prepare(
            `UPDATE "Media"
                SET "coverArtifactId" = ?, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ?`
        )
        .run(artifactId, mediaId);

    return result.changes > 0;
};

/** The next free ordinal for a kind — how a capture is appended without racing on count(). */
export const nextOrdinal = (mediaId: string, kind: ArtifactKind): number => {
    const row = db
        .prepare(
            `SELECT COALESCE(max("ordinal"), -1) + 1 AS "next"
               FROM "Artifact" WHERE "mediaId" = ? AND "kind" = ?`
        )
        .get(mediaId, kind) as { next: number };

    return row.next;
};

/**
 * Remove an artifact row and return it, so the caller can delete the file it names.
 *
 * Row first, file second, and never the reverse: a row pointing at a missing file renders as
 * a broken image, while a file with no row is invisible and merely wastes space until the
 * next sweep.
 */
export const remove = (id: string): ArtifactRow | undefined => {
    const row = findById(id);

    if (!row) {
        return undefined;
    }

    db.prepare(`DELETE FROM "Artifact" WHERE "id" = ?`).run(id);

    return row;
};

/**
 * Write or clear a capture's caption.
 *
 * `generatedAt` is left alone on purpose: it is the capture's `?v=` version token (§9) and
 * the Captures page's "recently captured" order, and a caption changes neither the picture
 * nor when it was taken. Refuses anything that is not a capture, so a generated frame can
 * never acquire a caption through a stray id.
 */
export const setLabel = (id: string, label: string | null): boolean =>
    db
        .prepare(`UPDATE "Artifact" SET "label" = ? WHERE "id" = ? AND "kind" = 'capture'`)
        .run(label?.slice(0, 200) ?? null, id).changes > 0;

/** A capture as the Captures page lists it: the still, its item, and its grid rendering. */
export interface CaptureSummaryRow extends ArtifactRow {
    mediaTitle: string | null;
    /** The 640px `cover-n` paired with this capture by ordinal, or null when there is none. */
    renderingId: string | null;
    renderingRelPath: string | null;
    renderingGeneratedAt: string | null;
    /** 1 when the item's chosen cover is this capture's rendering. */
    isCover: 1 | null;
}

interface CaptureScope {
    userId: string;
    /** Null means every root, which is what an administrator is given. */
    accessibleRootIds: string[] | null;
}

const CAPTURE_SORT: Record<CaptureSort, (order: string) => string> = {
    created: (order) => `a."generatedAt" ${order}, a."id" ASC`,
    // Timeline order inside one item whichever way the titles run: §9's rule for the strip.
    title: (order) =>
        `m."title" COLLATE NOCASE ${order}, a."mediaId" ASC, a."atMs" ASC, a."id" ASC`,
    position: (order) => `a."atMs" ${order}, a."id" ASC`,
};

/**
 * The Captures page's filter: this person's stills, of items that can be listed, in libraries
 * they can still reach.
 *
 * `kind = 'capture'` is written as a literal so `idx_Artifact_capture_owner` qualifies — a
 * partial index is only usable when the query states its condition. `listable` hides items in
 * the trash until they are restored (§10), as `/clips` does.
 */
const buildCaptureSearch = (
    query: Pick<CaptureQuery, "search">,
    scope: CaptureScope
): { where: string; params: Record<string, unknown> } => {
    // Not the stills of an item this person has hidden (§6), as the grid and playlists already do.
    const clauses = [
        `a."kind" = 'capture'`,
        `a."createdByUserId" = :userId`,
        `m."listable" = 1`,
        notHiddenSql(`a."mediaId"`),
    ];
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

    if (query.search) {
        clauses.push(`(a."label" LIKE :search ESCAPE '\\' OR m."title" LIKE :search ESCAPE '\\')`);
        params.search = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
    }

    return { where: `WHERE ${clauses.join(" AND ")}`, params };
};

export const searchCaptures = (
    query: Pick<CaptureQuery, "search" | "sort" | "limit" | "page">,
    scope: CaptureScope,
    direction: "asc" | "desc"
): CaptureSummaryRow[] => {
    const { where, params } = buildCaptureSearch(query, scope);
    const order = direction === "asc" ? "ASC" : "DESC";

    return db
        .prepare(
            `SELECT a."id", a."mediaId", a."kind", a."ordinal", a."relPath", a."width",
                    a."height", a."tileCount", a."intervalMs", a."bytes", a."atMs", a."source",
                    a."createdByUserId", a."label", a."generatorVersion", a."generatedAt",
                    m."title" AS "mediaTitle",
                    r."id" AS "renderingId",
                    r."relPath" AS "renderingRelPath",
                    r."generatedAt" AS "renderingGeneratedAt",
                    CASE WHEN r."id" IS NOT NULL AND r."id" = m."coverArtifactId"
                         THEN 1 END AS "isCover"
               FROM "Artifact" a
               JOIN "Media" m ON m."id" = a."mediaId"
               -- ordinal 0 is the generator's cover and never a capture's rendering (§9)
               LEFT JOIN "Artifact" r ON a."ordinal" > 0
                                     AND r."mediaId" = a."mediaId"
                                     AND r."kind" = 'cover'
                                     AND r."ordinal" = a."ordinal"
              ${where}
              ORDER BY ${CAPTURE_SORT[query.sort](order)}
              LIMIT :limit OFFSET :offset`
        )
        .all({
            ...params,
            limit: query.limit,
            offset: query.page * query.limit,
        }) as CaptureSummaryRow[];
};

export const countCaptures = (query: Pick<CaptureQuery, "search">, scope: CaptureScope): number => {
    const { where, params } = buildCaptureSearch(query, scope);

    return (
        db
            .prepare(
                `SELECT COUNT(*) AS n
                   FROM "Artifact" a JOIN "Media" m ON m."id" = a."mediaId" ${where}`
            )
            .get(params) as { n: number }
    ).n;
};

/**
 * Record that a media item's imagery changed, for the live feed.
 *
 * Kept next to the writes rather than in the job, so an artifact cannot be committed without
 * the grid hearing about it — a thumbnail appearing is the most visible sign the app is
 * working (§13b).
 */
export const recordArtifactChange = (
    mediaId: string,
    rootId: string | null,
    kind: ArtifactKind | typeof COVER_CLEARED_CHANGE
): void => {
    changeLogRepo.record({
        entity: "artifact",
        entityId: mediaId,
        rootId,
        op: "update",
        detail: kind,
    });
};
