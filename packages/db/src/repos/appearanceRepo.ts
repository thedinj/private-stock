import type { MediaKind } from "@private-stock/core";

import { db } from "../db.js";

import { activeDecision } from "./faceDecisionRepo.js";

/**
 * Appearances (§5f "A person in a video"): one person in one item — what Suggestions shows and
 * asks about. Written whole by the `faceAnchors` job; read here, and decided about through their
 * faces, so nothing is lost when a run makes them anew.
 */

/** A face as the appearances are made from it, in item order. */
export interface AppearanceSourceFace {
    id: string;
    mediaId: string;
    vectorIndex: number;
    eyes: number;
    score: number;
    kind: MediaKind;
    /** Taken out of grouping as "not one person": scored, but nobody's person. */
    scattered: 0 | 1;
}

/**
 * Every face, item by item, with what an appearance needs of it. Faces taken out of grouping as
 * "not one person", which somebody said are nobody in particular, are marked: they are scored
 * against the references like any face, but are part of no person.
 */
export const sourceFaces = (): AppearanceSourceFace[] =>
    db
        .prepare(
            `SELECT f."id", f."mediaId", f."vectorIndex", f."eyes", f."score", m."kind",
                    f."scatteredAt" IS NOT NULL AS "scattered"
               FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
              ORDER BY f."mediaId", f."vectorIndex"`
        )
        .all() as AppearanceSourceFace[];

/** One appearance as a run made it. */
export interface NewAppearance {
    id: string;
    mediaId: string;
    faceIds: string[];
    bestFaceId: string;
    legible: boolean;
    matchTagId: string | null;
    score: number | null;
    second: number | null;
}

/** Replace every appearance with a run's. One transaction, so a reader never sees half of one. */
export const replaceAll = (rows: readonly NewAppearance[]): void => {
    const insert = db.prepare(
        `INSERT INTO "FaceAppearance"
             ("id", "mediaId", "faceCount", "bestFaceId", "legible", "matchTagId", "score", "second")
         VALUES (@id, @mediaId, @faceCount, @bestFaceId, @legible, @matchTagId, @score, @second)`
    );
    const member = db.prepare(`UPDATE "Face" SET "appearanceId" = ? WHERE "id" = ?`);

    db.transaction(() => {
        db.prepare(
            `UPDATE "Face" SET "appearanceId" = NULL WHERE "appearanceId" IS NOT NULL`
        ).run();
        db.prepare(`DELETE FROM "FaceAppearance"`).run();

        for (const row of rows) {
            insert.run({
                id: row.id,
                mediaId: row.mediaId,
                faceCount: row.faceIds.length,
                bestFaceId: row.bestFaceId,
                legible: row.legible ? 1 : null,
                matchTagId: row.matchTagId,
                score: row.score,
                second: row.second,
            });

            for (const faceId of row.faceIds) member.run(row.id, faceId);
        }
    })();
};

/** The lines a suggestion is drawn at (§5f "Suggestions"), from core. */
export interface SuggestLines {
    line: number;
    margin: number;
    namedLine: number;
}

const visible = (rootIds: readonly string[], params: Record<string, unknown>): string => {
    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    return rootIds.length === 0
        ? "0"
        : `m."listable" = 1 AND m."listRootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})`;
};

/**
 * What makes an appearance a suggestion for its best match (§5f "Suggestions"): legible, clearly
 * them, on an item that does not carry them and was not refused for them, with none of its faces
 * confirmed as anybody or refused for them by somebody who saw it.
 */
const SUGGESTED = `
    a."matchTagId" IS NOT NULL AND a."legible" = 1 AND a."score" - a."second" >= :margin
    AND (a."score" >= :line
         OR (a."score" >= :namedLine
             AND EXISTS (SELECT 1 FROM "MediaMention" mm
                          WHERE mm."mediaId" = a."mediaId" AND mm."tagId" = a."matchTagId")))
    AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                     WHERE mt."mediaId" = a."mediaId" AND mt."tagId" = a."matchTagId")
    AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" ir
                     WHERE ir."mediaId" = a."mediaId" AND ir."tagId" = a."matchTagId")
    AND NOT EXISTS (SELECT 1 FROM "PerformerNoFace" nf WHERE nf."tagId" = a."matchTagId")
    AND NOT EXISTS (SELECT 1 FROM "Face" f
                     WHERE f."appearanceId" = a."id"
                       AND (f."tagId" IS NOT NULL
                            OR EXISTS (SELECT 1 FROM "FaceRefusal" r
                                        WHERE r."faceId" = f."id" AND r."tagId" = a."matchTagId"
                                          AND r."how" IS NOT 'inferred')))`;

/** Every performer with suggestions, and how many, most first. */
export const suggestedPerformers = (
    rootIds: readonly string[],
    lines: SuggestLines,
    kind: MediaKind | null
): { tagId: string; count: number }[] => {
    const params: Record<string, unknown> = { ...lines, kind };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT a."matchTagId" AS "tagId", count(*) AS "count"
               FROM "FaceAppearance" a JOIN "Media" m ON m."id" = a."mediaId"
              WHERE ${where} AND (:kind IS NULL OR m."kind" = :kind) AND ${SUGGESTED}
              GROUP BY a."matchTagId"
              ORDER BY "count" DESC, a."matchTagId"`
        )
        .all(params) as { tagId: string; count: number }[];
};

/** A suggested appearance, as a card shows it. */
export interface SuggestionRow {
    id: string;
    mediaId: string;
    kind: MediaKind;
    title: string;
    faceCount: number;
    bestFaceId: string;
    score: number;
    named: 0 | 1;
}

/**
 * One performer's suggestions, surest first, a page at a time after `after` (a score and an id).
 */
export const suggestions = (query: {
    tagId: string;
    rootIds: readonly string[];
    lines: SuggestLines;
    kind: MediaKind | null;
    after: { score: number; id: string } | null;
    limit: number;
}): SuggestionRow[] => {
    const params: Record<string, unknown> = {
        ...query.lines,
        tagId: query.tagId,
        kind: query.kind,
        afterScore: query.after?.score ?? null,
        afterId: query.after?.id ?? null,
        limit: query.limit,
    };
    const where = visible(query.rootIds, params);

    return db
        .prepare(
            `SELECT a."id", a."mediaId", m."kind", m."title", a."faceCount", a."bestFaceId", a."score",
                    EXISTS (SELECT 1 FROM "MediaMention" mm
                             WHERE mm."mediaId" = a."mediaId" AND mm."tagId" = a."matchTagId") AS "named"
               FROM "FaceAppearance" a JOIN "Media" m ON m."id" = a."mediaId"
              WHERE a."matchTagId" = :tagId AND ${where} AND (:kind IS NULL OR m."kind" = :kind)
                AND ${SUGGESTED}
                AND (:afterScore IS NULL OR a."score" < :afterScore
                     OR (a."score" = :afterScore AND a."id" > :afterId))
              ORDER BY a."score" DESC, a."id"
              LIMIT :limit`
        )
        .all(params) as SuggestionRow[];
};

/** The faces of these appearances, clearest first within each: what a card shows and decides. */
export const appearanceFaces = (
    appearanceIds: readonly string[]
): {
    appearanceId: string;
    id: string;
    mediaId: string;
    kind: MediaKind;
    atMs: number | null;
    x: number;
    y: number;
    w: number;
    h: number;
}[] =>
    db
        .prepare(
            `SELECT f."appearanceId", f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h"
               FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
              WHERE f."appearanceId" IN (SELECT value FROM json_each(?))
              ORDER BY f."appearanceId", f."eyes" * f."score" DESC`
        )
        .all(JSON.stringify(appearanceIds)) as ReturnType<typeof appearanceFaces>;

/** Of these faces, those on this item: what a decision about one appearance may touch. */
export const facesOnItem = (mediaId: string, faceIds: readonly string[]): string[] =>
    db
        .prepare(
            `SELECT "id" FROM "Face"
              WHERE "mediaId" = ? AND "id" IN (SELECT value FROM json_each(?))`
        )
        .pluck()
        .all(mediaId, JSON.stringify(faceIds)) as string[];

/**
 * "That's them", of one person in one item: their faces confirmed — the one shown as `shown`, the
 * rest as `inferred` — and any refusal of them for the performer withdrawn, the later word. Faces
 * already somebody's stay theirs. Returns the faces confirmed.
 */
export const confirmPerson = (
    faceIds: readonly string[],
    shownFaceId: string,
    tagId: string,
    userId: string
): number => {
    const params = {
        ids: JSON.stringify(faceIds),
        shown: shownFaceId,
        tagId,
        userId,
        decision: activeDecision(),
    };

    db.prepare(
        `DELETE FROM "FaceRefusal"
          WHERE "tagId" = :tagId AND "faceId" IN (SELECT value FROM json_each(:ids))`
    ).run(params);

    return db
        .prepare(
            `UPDATE "Face"
                SET "tagId" = :tagId, "decidedByUserId" = :userId, "decidedAt" = CURRENT_TIMESTAMP,
                    "decidedHow" = CASE WHEN "id" = :shown THEN 'shown' ELSE 'inferred' END,
                    "decisionId" = :decision
              WHERE "id" IN (SELECT value FROM json_each(:ids)) AND "tagId" IS NULL`
        )
        .run(params).changes;
};

/** "Not them", of one person in one item: their faces refused for the performer. */
export const refusePerson = (
    faceIds: readonly string[],
    shownFaceId: string,
    tagId: string,
    userId: string
): number =>
    db
        .prepare(
            `INSERT OR IGNORE INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "how", "decisionId")
             SELECT value, :tagId, :userId,
                    CASE WHEN value = :shown THEN 'shown' ELSE 'inferred' END, :decision
               FROM json_each(:ids)`
        )
        .run({
            ids: JSON.stringify(faceIds),
            shown: shownFaceId,
            tagId,
            userId,
            decision: activeDecision(),
        }).changes;
