import { randomUUID } from "node:crypto";

import { db } from "../db.js";

import { activeDecision } from "./faceDecisionRepo.js";

/**
 * The faces each item shows, and what people have said about them (§5f).
 *
 * The worker's `faces` stage writes the rows; a person's decisions are written by the review that
 * comes later. The two meet here: the stage replaces an item's faces when it runs again, and must
 * not lose a decision while doing it.
 */

/** A face as the stage found it. The box is fractions of the picture it was found in. */
export interface FoundFace {
    vectorIndex: number;
    atMs: number | null;
    x: number;
    y: number;
    w: number;
    h: number;
    eyes: number;
    score: number;
}

/**
 * How a decision about a face was made (§5f "Corrections stick"): the face was on screen, the
 * whole item was spoken for, or it was carried to a face nobody saw.
 */
export type DecidedHow = "shown" | "item" | "inferred";

interface FaceRow extends FoundFace {
    id: string;
    tagId: string | null;
    decidedByUserId: string | null;
    decidedAt: string | null;
    decidedHow: DecidedHow | null;
    skippedAt: string | null;
    skippedByUserId: string | null;
    scatteredAt: string | null;
    scatteredByUserId: string | null;
    decisionId: string | null;
}

interface RefusalRow {
    faceId: string;
    tagId: string;
    decidedByUserId: string | null;
    decidedAt: string;
    how: DecidedHow | null;
    decisionId: string | null;
}

/** How much two boxes are the same box: intersection over union. */
const overlap = (a: FoundFace, b: FoundFace): number => {
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = w * h;

    return inter / (a.w * a.h + b.w * b.h - inter);
};

/**
 * Where a face found again is the face somebody decided about: the same moment, and boxes that
 * are mostly the same box. Half is generous enough for a detector's jitter between versions and
 * strict enough that two people side by side are never mistaken for each other.
 */
const SAME_FACE = 0.5;

/**
 * How far apart in time a face found again may be and still be the face decided about. Exactly
 * the same moment used to be required, so anything that moved the sprite's tiles — a longer or
 * shorter interval, a re-made sheet — dropped every decision on the item; and once tags are made
 * by themselves, a dropped refusal is a removed tag coming back. Two seconds is a tile or two at
 * the usual intervals, and the box must still be mostly the same box.
 */
const SAME_MOMENT_MS = 2_000;

const insertFace = (row: Omit<FaceRow, "eyes"> & { eyes: number; mediaId: string }): void => {
    db.prepare(
        `INSERT INTO "Face" ("id", "mediaId", "vectorIndex", "atMs", "x", "y", "w", "h", "eyes",
                             "score", "tagId", "decidedByUserId", "decidedAt", "decidedHow",
                             "skippedAt", "skippedByUserId", "scatteredAt", "scatteredByUserId",
                             "decisionId")
         VALUES (@id, @mediaId, @vectorIndex, @atMs, @x, @y, @w, @h, @eyes,
                 @score, @tagId, @decidedByUserId, @decidedAt, @decidedHow,
                 @skippedAt, @skippedByUserId, @scatteredAt, @scatteredByUserId, @decisionId)`
    ).run(row);
};

const insertRefusal = (row: RefusalRow): void => {
    db.prepare(
        `INSERT OR IGNORE INTO "FaceRefusal"
             ("faceId", "tagId", "decidedByUserId", "decidedAt", "how", "decisionId")
         VALUES (@faceId, @tagId, @decidedByUserId, @decidedAt, @how, @decisionId)`
    ).run(row);
};

const facesOf = (mediaId: string): FaceRow[] =>
    db
        .prepare(
            `SELECT "id", "vectorIndex", "atMs", "x", "y", "w", "h", "eyes", "score",
                    "tagId", "decidedByUserId", "decidedAt", "decidedHow",
                    "skippedAt", "skippedByUserId", "scatteredAt", "scatteredByUserId", "decisionId"
               FROM "Face" WHERE "mediaId" = ? ORDER BY "vectorIndex"`
        )
        .all(mediaId) as FaceRow[];

const refusalsOf = (mediaId: string): RefusalRow[] =>
    db
        .prepare(
            `SELECT r."faceId", r."tagId", r."decidedByUserId", r."decidedAt", r."how",
                    r."decisionId"
               FROM "FaceRefusal" r JOIN "Face" f ON f."id" = r."faceId"
              WHERE f."mediaId" = ?`
        )
        .all(mediaId) as RefusalRow[];

/**
 * An item's faces, replaced by what the stage found this time.
 *
 * What people said is carried across: each decided face's confirmation, refusals and "can't tell"
 * move to the new face at the nearest moment, within `SAME_MOMENT_MS`, whose box is mostly the
 * same box (`SAME_FACE`). A decided face with
 * no such successor — the detector no longer finds it, or it fell out of the twelve kept — takes
 * its decision with it; the review will ask again, which is the honest outcome.
 *
 * One transaction, so a reader never sees the item with no faces, or with both sets.
 */
export const replaceForMedia = (mediaId: string, faces: readonly FoundFace[]): void => {
    db.transaction(() => {
        const old = facesOf(mediaId);
        const refusals = refusalsOf(mediaId);
        const decided = old.filter(
            (face) =>
                face.tagId !== null ||
                face.skippedAt !== null ||
                face.scatteredAt !== null ||
                refusals.some((r) => r.faceId === face.id)
        );

        db.prepare(`DELETE FROM "Face" WHERE "mediaId" = ?`).run(mediaId);

        const fresh = faces.map((face) => ({ ...face, id: randomUUID() }));
        const successor = new Map<string, (typeof fresh)[number]>();

        for (const face of decided) {
            let best: (typeof fresh)[number] | null = null;
            let bestOverlap = SAME_FACE;

            let bestGap = Infinity;

            for (const candidate of fresh) {
                const gap =
                    candidate.atMs === null || face.atMs === null
                        ? candidate.atMs === face.atMs
                            ? 0
                            : Infinity
                        : Math.abs(candidate.atMs - face.atMs);

                if (gap > SAME_MOMENT_MS) continue;

                const o = overlap(face, candidate);

                // The nearest moment first, then the most overlap: a shifted tile is still the
                // same face; two faces at one moment are told apart by where they are.
                if (o >= SAME_FACE && (gap < bestGap || (gap === bestGap && o >= bestOverlap))) {
                    best = candidate;
                    bestOverlap = o;
                    bestGap = gap;
                }
            }

            if (best) successor.set(face.id, best);
        }

        const inherited = new Map<string, FaceRow>();

        for (const [oldId, face] of successor) {
            const was = decided.find((d) => d.id === oldId)!;

            if (was.tagId !== null || was.skippedAt !== null || was.scatteredAt !== null) {
                inherited.set(face.id, was);
            }
        }

        for (const face of fresh) {
            const was = inherited.get(face.id);

            insertFace({
                ...face,
                mediaId,
                tagId: was?.tagId ?? null,
                decidedByUserId: was?.decidedByUserId ?? null,
                decidedAt: was?.decidedAt ?? null,
                decidedHow: was?.decidedHow ?? null,
                skippedAt: was?.skippedAt ?? null,
                skippedByUserId: was?.skippedByUserId ?? null,
                scatteredAt: was?.scatteredAt ?? null,
                scatteredByUserId: was?.scatteredByUserId ?? null,
                decisionId: was?.decisionId ?? null,
            });
        }

        for (const refusal of refusals) {
            const face = successor.get(refusal.faceId);

            if (face) insertRefusal({ ...refusal, faceId: face.id });
        }
    })();
};

/**
 * An identical copy's faces are this item's faces (§10f): its rows copied with fresh ids, the
 * vectors file borrowed beside them. Decisions come too — the same file shows the same people —
 * merged with whatever was decided about this item's own faces before.
 *
 * Returns how many faces the twin had; zero means there was nothing to borrow.
 */
export const copyFromTwin = (fromMediaId: string, toMediaId: string): number => {
    const faces = facesOf(fromMediaId);

    if (faces.length === 0) {
        return 0;
    }

    db.transaction(() => {
        replaceForMedia(toMediaId, faces);

        // The twin's own decisions, onto the copies just made: same index, same face.
        const copies = new Map(facesOf(toMediaId).map((face) => [face.vectorIndex, face.id]));

        for (const face of faces) {
            const copy = copies.get(face.vectorIndex)!;

            if (face.tagId !== null) {
                db.prepare(
                    `UPDATE "Face"
                        SET "tagId" = ?, "decidedByUserId" = ?, "decidedAt" = ?, "decidedHow" = ?,
                            "decisionId" = ?
                      WHERE "id" = ? AND "tagId" IS NULL`
                ).run(
                    face.tagId,
                    face.decidedByUserId,
                    face.decidedAt,
                    face.decidedHow,
                    face.decisionId,
                    copy
                );
            }

            if (face.skippedAt !== null) {
                db.prepare(
                    `UPDATE "Face" SET "skippedAt" = ?, "skippedByUserId" = ?,
                            "decisionId" = coalesce("decisionId", ?)
                      WHERE "id" = ? AND "skippedAt" IS NULL`
                ).run(face.skippedAt, face.skippedByUserId, face.decisionId, copy);
            }

            if (face.scatteredAt !== null) {
                db.prepare(
                    `UPDATE "Face" SET "scatteredAt" = ?, "scatteredByUserId" = ?,
                            "decisionId" = coalesce("decisionId", ?)
                      WHERE "id" = ? AND "scatteredAt" IS NULL`
                ).run(face.scatteredAt, face.scatteredByUserId, face.decisionId, copy);
            }
        }

        for (const refusal of refusalsOf(fromMediaId)) {
            const index = faces.find((face) => face.id === refusal.faceId)!.vectorIndex;

            insertRefusal({ ...refusal, faceId: copies.get(index)! });
        }
    })();

    return faces.length;
};

/** A face as a performer's page shows it: where, so it can be cropped, and on what. */
export interface ShownFace {
    id: string;
    mediaId: string;
    kind: "video" | "image";
    atMs: number | null;
    x: number;
    y: number;
    w: number;
    h: number;
}

const visible = (rootIds: readonly string[], params: Record<string, unknown>): string => {
    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    return rootIds.length === 0
        ? "0"
        : `m."listable" = 1 AND m."listRootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})`;
};

/** Faces as a list shows them, by id. */
export const shownFaces = (faceIds: readonly string[]): ShownFace[] =>
    db
        .prepare(
            `SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h"
               FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
              WHERE f."id" IN (SELECT value FROM json_each(?))`
        )
        .all(JSON.stringify(faceIds)) as ShownFace[];

/** When a performer was said to have no single face (§5f), if they were. */
export const noSingleFace = (tagId: string): { decidedAt: string } | undefined =>
    db.prepare(`SELECT "decidedAt" FROM "PerformerNoFace" WHERE "tagId" = ?`).get(tagId) as
        { decidedAt: string } | undefined;

/** Say a performer has no single face, or take it back. */
export const setNoSingleFace = (tagId: string, noFace: boolean, userId: string): void => {
    if (noFace) {
        db.prepare(
            `INSERT OR IGNORE INTO "PerformerNoFace" ("tagId", "decidedByUserId") VALUES (?, ?)`
        ).run(tagId, userId);
    } else {
        db.prepare(`DELETE FROM "PerformerNoFace" WHERE "tagId" = ?`).run(tagId);
    }
};

/** Every face a person confirmed as a library performer: what references are built from first. */
export const confirmedFaceRefs = (): {
    tagId: string;
    mediaId: string;
    vectorIndex: number;
}[] =>
    db
        .prepare(
            `SELECT f."tagId", f."mediaId", f."vectorIndex"
               FROM "Face" f JOIN "Tag" t ON t."id" = f."tagId"
              WHERE t."kind" = 'performer' AND t."ownerId" IS NULL
                AND NOT EXISTS (SELECT 1 FROM "PerformerNoFace" nf WHERE nf."tagId" = t."id")`
        )
        .all() as { tagId: string; mediaId: string; vectorIndex: number }[];

/**
 * The faces on items carrying each library performer, not refused for them: what the face their
 * items share is looked for in. Tags a person made, read or matched — never one made by itself
 * from a face (`source = 'ai'`), or a reference would vouch for itself. At most `perTag` items
 * each, newest first: the search is the square of their faces.
 */
export const taggedFaceRefs = (
    perTag: number
): { tagId: string; faceId: string; mediaId: string; vectorIndex: number }[] =>
    db
        .prepare(
            `SELECT x."tagId", f."id" AS "faceId", f."mediaId", f."vectorIndex"
               FROM (
                 SELECT mt."tagId", mt."mediaId",
                        row_number() OVER (PARTITION BY mt."tagId" ORDER BY mt."createdAt" DESC) AS "n"
                   FROM "MediaTag" mt
                   JOIN "Tag" t ON t."id" = mt."tagId" AND t."kind" = 'performer' AND t."ownerId" IS NULL
                   JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
                  WHERE mt."userId" IS NULL AND mt."source" <> 'ai'
                    AND NOT EXISTS (SELECT 1 FROM "PerformerNoFace" nf WHERE nf."tagId" = t."id")
                    AND EXISTS (SELECT 1 FROM "Face" f WHERE f."mediaId" = mt."mediaId")
               ) x
               JOIN "Face" f ON f."mediaId" = x."mediaId"
              WHERE x."n" <= ? AND f."scatteredAt" IS NULL
                AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                 WHERE r."faceId" = f."id" AND r."tagId" = x."tagId")`
        )
        .all(perTag) as { tagId: string; faceId: string; mediaId: string; vectorIndex: number }[];

/** A performer's reference, as the table keeps what it was built from. */
export interface AnchorRow {
    tagId: string;
    items: number;
    confirmedItems: number;
    sharedItems: number;
}

/** Replace every reference and every face's best match with a run's. One transaction. */
export const replaceAnchors = (
    anchors: readonly AnchorRow[],
    matches: readonly { faceId: string; tagId: string; score: number; second: number }[]
): void => {
    const anchor = db.prepare(
        `INSERT INTO "FaceAnchor" ("tagId", "items", "confirmedItems", "sharedItems")
         VALUES (@tagId, @items, @confirmedItems, @sharedItems)`
    );
    const match = db.prepare(
        `INSERT OR REPLACE INTO "FaceMatch" ("faceId", "tagId", "score", "second")
         SELECT @faceId, @tagId, @score, @second
          WHERE EXISTS (SELECT 1 FROM "Face" WHERE "id" = @faceId)`
    );

    db.transaction(() => {
        db.prepare(`DELETE FROM "FaceMatch"`).run();
        db.prepare(`DELETE FROM "FaceAnchor"`).run();
        for (const row of anchors) anchor.run(row);
        for (const row of matches) match.run(row);
    })();
};

/** A performer's reference, if they have one. */
export const anchorOf = (tagId: string): AnchorRow | undefined =>
    db
        .prepare(
            `SELECT "tagId", "items", "confirmedItems", "sharedItems" FROM "FaceAnchor"
              WHERE "tagId" = ?`
        )
        .get(tagId) as AnchorRow | undefined;

/**
 * Every face confirmed as the performer on items this viewer can see, largest and surest first —
 * every moment, not one an item — a page at a time, with how many there are: what their picture
 * is chosen from (§6 "A tag's picture").
 */
export const everyConfirmedFace = (
    tagId: string,
    rootIds: readonly string[],
    limit: number,
    offset: number
): { faces: ShownFace[]; total: number } => {
    const params: Record<string, unknown> = { tagId, limit, offset };
    const where = visible(rootIds, params);
    const from = `FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE f."tagId" = :tagId AND ${where}`;

    return {
        faces: db
            .prepare(
                `SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h"
                   ${from}
                  ORDER BY f."h" * f."score" DESC, f."id"
                  LIMIT :limit OFFSET :offset`
            )
            .all(params) as ShownFace[],
        total: (
            db.prepare(`SELECT count(*) AS "n" ${from}`).get({
                tagId,
                ...Object.fromEntries(rootIds.map((id, i) => [`root${i}`, id])),
            }) as {
                n: number;
            }
        ).n,
    };
};

/** A face the automatic picture might be cut around, with the file it is in. */
export interface PictureCandidate {
    tagId: string;
    mediaId: string;
    kind: "video" | "image";
    atMs: number | null;
    x: number;
    y: number;
    w: number;
    h: number;
    score: number;
    fileId: string;
    /**
     * How good a source of their picture it is (§6 "A tag's picture"): 1, a confirmed face that
     * clears the bars; 2, a face their automatic tag rests on that clears them; 3, a confirmed
     * face that does not, cut at a smaller size; 4, on an item tagged with them, the person who
     * looks most like them, nobody having said so -- for a performer with no face of their own.
     */
    tier: 1 | 2 | 3 | 4;
}

/**
 * For every library performer, the faces most worth a picture, best tier first and, within a
 * tier, largest and surest first: one an item, at most `perTier` a tier. On items anybody can
 * see — not in the trash.
 *
 * The bars are at least `minScore` sure and filling at least `minShare` of the frame's height.
 * A confirmed face is one a person said is them. A face an automatic tag rests on counts while
 * that tag stands -- applied and not taken back, or checked as right, and still on the item -- and the face itself was
 * not refused for them. Whether one is large enough in the original is known only once the frame
 * is read, so a few are offered in case the first is not.
 *
 * The last tier is a guess, for a performer nobody has confirmed a face of: on an item the library
 * tags with them, the person matched to them at least `matchLine` (§5f "A person in a video"),
 * whose face is not confirmed as somebody else nor refused for them.
 */
export const pictureCandidates = (
    minScore: number,
    minShare: number,
    perTier: number,
    matchLine: number
): PictureCandidate[] =>
    db
        .prepare(
            `WITH "faces" AS (
                 SELECT f."id", f."tagId", f."mediaId", f."atMs", f."x", f."y", f."w", f."h",
                        f."score",
                        CASE WHEN f."score" >= :minScore AND f."h" >= :minShare THEN 1 ELSE 3 END
                            AS "tier"
                   FROM "Face" f
                  WHERE f."tagId" IS NOT NULL
                 UNION ALL
                 SELECT f."id", a."tagId", f."mediaId", f."atMs", f."x", f."y", f."w", f."h",
                        f."score", 2
                   FROM "FaceAutoTag" a JOIN "Face" f ON f."id" = a."faceId"
                  WHERE a."state" IN ('applied', 'right') AND f."tagId" IS NULL
                    AND f."score" >= :minScore AND f."h" >= :minShare
                    -- An undo takes the tag off without marking it taken back.
                    AND EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = a."mediaId" AND mt."tagId" = a."tagId"
                                   AND mt."userId" IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                     WHERE r."faceId" = f."id" AND r."tagId" = a."tagId")
                 UNION ALL
                 SELECT f."id", p."matchTagId", f."mediaId", f."atMs", f."x", f."y", f."w", f."h",
                        f."score", 4
                   FROM "FaceAppearance" p JOIN "Face" f ON f."id" = p."bestFaceId"
                  WHERE p."matchTagId" IS NOT NULL AND p."score" >= :matchLine
                    AND f."tagId" IS NULL
                    AND EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = p."mediaId" AND mt."tagId" = p."matchTagId"
                                   AND mt."userId" IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                     WHERE r."faceId" = f."id" AND r."tagId" = p."matchTagId")
             )
             SELECT "tagId", "mediaId", "kind", "atMs", "x", "y", "w", "h", "score", "fileId",
                    "tier"
               FROM (
                 SELECT f."tagId", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        f."score", f."tier", fl."fileId",
                        row_number() OVER (PARTITION BY f."tagId", f."tier"
                                           ORDER BY f."h" * f."score" DESC, f."id") AS "n"
                   FROM (
                     SELECT *, row_number() OVER (PARTITION BY "tagId", "tier", "mediaId"
                                                  ORDER BY "h" * "score" DESC, "id") AS "inItem"
                       FROM "faces"
                   ) f
                   JOIN "Tag" t ON t."id" = f."tagId" AND t."kind" = 'performer'
                               AND t."ownerId" IS NULL
                   JOIN "Media" m ON m."id" = f."mediaId" AND m."listable" = 1
                   JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
                  WHERE f."inItem" = 1
             ) WHERE "n" <= :perTier
              ORDER BY "tagId", "tier", "n"`
        )
        .all({ minScore, minShare, perTier, matchLine }) as PictureCandidate[];

/**
 * "Not them", said of whole items: every face on them refused for the performer. What taking a
 * performer off an item by hand means (§5f "Corrections stick"). Returns the faces refused.
 */
export const refuseOnItems = (mediaIds: readonly string[], tagId: string, userId: string): number =>
    db
        .prepare(
            `INSERT OR IGNORE INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "how", "decisionId")
             SELECT "id", ?, ?, 'item', ? FROM "Face" WHERE "mediaId" IN (SELECT value FROM json_each(?))`
        )
        .run(tagId, userId, activeDecision(), JSON.stringify(mediaIds)).changes;
