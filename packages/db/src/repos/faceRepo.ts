import { randomUUID } from "node:crypto";

import type { MediaKind } from "@private-stock/core";

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

/**
 * Items with faces added since `cursor` — a `Face` rowid — in the order they were added, each
 * with its kind and its newest face's rowid: what the grouping job reads next (§5f).
 *
 * A re-run of the stage gives an item new rows, so it is grouped again; its old faces' share of
 * their groups' sums stays behind, a drift the occasional rebuild from scratch clears.
 */
export const itemsToGroup = (
    cursor: number,
    limit: number
): { mediaId: string; kind: "video" | "image"; last: number }[] =>
    db
        .prepare(
            `SELECT f."mediaId", m."kind", max(f."rowid") AS "last"
               FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
              GROUP BY f."mediaId"
             HAVING max(f."rowid") > ?
              ORDER BY "last"
              LIMIT ?`
        )
        .all(cursor, limit) as { mediaId: string; kind: "video" | "image"; last: number }[];

/**
 * An item's faces as the grouping job needs them: id, and where its vector is in the file. Not a
 * face somebody said is in no one person's group: it is never grouped again (§5f "Grab bags").
 */
export const facesToGroup = (mediaId: string): { id: string; vectorIndex: number }[] =>
    db
        .prepare(
            `SELECT "id", "vectorIndex" FROM "Face"
              WHERE "mediaId" = ? AND "scatteredAt" IS NULL ORDER BY "vectorIndex"`
        )
        .all(mediaId) as { id: string; vectorIndex: number }[];

/**
 * "Not one person", said of a group (§5f "Grab bags"): its undecided faces leave it for good —
 * never grouped again, counted as evidence or tagged by themselves — and the group is dissolved,
 * for the grouping job to drop from its sums. Faces somebody confirmed as a performer stay theirs.
 * Returns the faces taken out.
 */
export const scatterGroup = (groupId: string, userId: string): number =>
    db.transaction((): number => {
        const changed = db
            .prepare(
                `UPDATE "Face"
                    SET "scatteredAt" = CURRENT_TIMESTAMP, "scatteredByUserId" = ?, "groupId" = NULL,
                        "decisionId" = ?
                  WHERE "groupId" = ? AND "tagId" IS NULL`
            )
            .run(userId, activeDecision(), groupId).changes;

        db.prepare(`INSERT OR IGNORE INTO "FaceGroupDissolved" ("groupId") VALUES (?)`).run(
            groupId
        );

        return changed;
    })();

/** Groups dissolved since the grouping job last ran: to drop from its sums. */
export const dissolvedGroups = (): string[] =>
    db.prepare(`SELECT "groupId" FROM "FaceGroupDissolved"`).pluck().all() as string[];

/** Groups the grouping job has dropped. */
export const forgetDissolved = (groupIds: readonly string[]): void => {
    db.prepare(
        `DELETE FROM "FaceGroupDissolved" WHERE "groupId" IN (SELECT value FROM json_each(?))`
    ).run(JSON.stringify(groupIds));
};

/** Every group's cohesion, replaced whole by a grouping run. One transaction. */
export const replaceGroupStats = (rows: readonly { groupId: string; cohesion: number }[]): void => {
    const insert = db.prepare(
        `INSERT OR REPLACE INTO "FaceGroupStat" ("groupId", "cohesion") VALUES (@groupId, @cohesion)`
    );

    db.transaction(() => {
        db.prepare(`DELETE FROM "FaceGroupStat"`).run();
        for (const row of rows) insert.run(row);
    })();
};

/** Whether any cohesion has been written: a library grouped before it was kept has none. */
export const hasGroupStats = (): boolean =>
    db.prepare(`SELECT 1 FROM "FaceGroupStat" LIMIT 1`).get() !== undefined;

/**
 * Write a grouping run's decisions: each face's group (null for a face seen once and so in no
 * group), and groups merged into another, whose faces move with them. One transaction.
 */
export const applyGroups = (
    assigned: readonly { id: string; groupId: string | null }[],
    merged: readonly { from: string; to: string }[]
): void => {
    const assign = db.prepare(`UPDATE "Face" SET "groupId" = ? WHERE "id" = ?`);
    const move = db.prepare(`UPDATE "Face" SET "groupId" = ? WHERE "groupId" = ?`);

    db.transaction(() => {
        for (const { from, to } of merged) move.run(to, from);
        for (const { id, groupId } of assigned) assign.run(groupId, id);
    })();
};

/** Forget every group: the start of a rebuild from scratch. */
export const clearGroups = (): void => {
    db.prepare(`UPDATE "Face" SET "groupId" = NULL WHERE "groupId" IS NOT NULL`).run();
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

/**
 * Items carrying exactly one library performer, and which: what proposes a group (§5f). Not tags
 * made by faces themselves: a proposal built on them would justify more of them.
 */
const singlePerformer = (among = ""): string => `
    SELECT mt."mediaId", max(mt."tagId") AS "tagId"
      FROM "MediaTag" mt JOIN "Tag" t ON t."id" = mt."tagId" AND t."kind" = 'performer'
     WHERE mt."userId" IS NULL AND t."ownerId" IS NULL AND mt."source" <> 'ai' ${among}
       AND NOT EXISTS (SELECT 1 FROM "PerformerNoFace" nf WHERE nf."tagId" = t."id")

     GROUP BY mt."mediaId"
    HAVING count(*) = 1`;

/**
 * Only the faces in these groups, as conditions on `f` and on `mt` -- with the parameter they
 * read. A read about one performer asks about the few groups that concern them, not every group
 * there is.
 *
 * `join` is how the faces meet their items: `CROSS JOIN`, which SQLite never reorders, when the
 * groups are given. Otherwise the planner starts from every item the viewer can see -- the
 * libraries condition is the one it has an index for -- and walks the whole library to find a
 * few groups' faces.
 */
const inGroups = (groupIds: readonly string[] | undefined, params: Record<string, unknown>) => {
    if (!groupIds) {
        return { faces: "", media: "", join: "JOIN" };
    }

    params.groups = JSON.stringify(groupIds);
    const faces = `f."groupId" IN (SELECT value FROM json_each(:groups))`;

    return {
        faces: `AND ${faces}`,
        media: `AND mt."mediaId" IN (SELECT f."mediaId" FROM "Face" f WHERE ${faces})`,
        join: "CROSS JOIN",
    };
};

/**
 * Whether an item carries a tag, by anybody. Two probes rather than one: `MediaTag`'s indexes
 * by item are partial -- the library's tags and people's own -- so a single condition on the
 * item and tag can use neither, and walks every item the tag is on instead, once for each face.
 */
const carries = (media: string, tag: string): string =>
    `(EXISTS (SELECT 1 FROM "MediaTag" mt
               WHERE mt."mediaId" = ${media} AND mt."tagId" = ${tag} AND mt."userId" IS NULL)
      OR EXISTS (SELECT 1 FROM "MediaTag" mt
                  WHERE mt."mediaId" = ${media} AND mt."tagId" = ${tag}
                    AND mt."userId" IS NOT NULL))`;

/**
 * The face groups that might be this library performer's by their evidence: holding a face
 * confirmed as them, or on one of their single-performer items. Read from the performer's side,
 * through their tags and confirmations, so it costs what they have rather than what the library
 * has.
 */
export const performerGroupIds = (tagId: string): string[] =>
    (
        db
            .prepare(
                `SELECT f."groupId" FROM "Face" f
                  WHERE f."groupId" IS NOT NULL AND f."tagId" = :tagId
                 UNION
                 SELECT f."groupId"
                   FROM "MediaTag" mt
                   JOIN "Tag" t ON t."id" = mt."tagId" AND t."kind" = 'performer'
                                AND t."ownerId" IS NULL
                   JOIN "Face" f ON f."mediaId" = mt."mediaId"
                  WHERE mt."tagId" = :tagId AND mt."userId" IS NULL AND mt."source" <> 'ai'
                    AND f."groupId" IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM "MediaTag" o
                          JOIN "Tag" ot ON ot."id" = o."tagId" AND ot."kind" = 'performer'
                                       AND ot."ownerId" IS NULL
                         WHERE o."mediaId" = mt."mediaId" AND o."tagId" <> mt."tagId"
                           AND o."userId" IS NULL AND o."source" <> 'ai'
                           AND NOT EXISTS (SELECT 1 FROM "PerformerNoFace" nf
                                            WHERE nf."tagId" = ot."id")
                    )`
            )
            .all({ tagId }) as { groupId: string }[]
    ).map((row) => row.groupId);

/**
 * The face groups holding a face whose best match is this performer, at least `line` alike and
 * `margin` more than like anybody else: the groups that might look like them (§5f "One face, one
 * score").
 */
export const likenessGroupIds = (tagId: string, line: number, margin: number): string[] =>
    (
        db
            .prepare(
                `SELECT DISTINCT f."groupId"
                   FROM "FaceMatch" fm JOIN "Face" f ON f."id" = fm."faceId"
                  WHERE fm."tagId" = :tagId AND fm."score" >= :line
                    AND fm."score" - fm."second" >= :margin AND f."groupId" IS NOT NULL`
            )
            .all({ tagId, line, margin }) as { groupId: string }[]
    ).map((row) => row.groupId);

/** A face group's counts about one performer, among the items this viewer can see. */
export interface GroupEvidenceRow {
    groupId: string;
    faceCount: number;
    itemCount: number;
    /**
     * Items not carrying the performer with a face here not refused for them: what is still to
     * ask about. An item whose faces somebody unticked is decided, tagged or not.
     */
    untaggedCount: number;
    taggedAsThem: number;
    taggedAsOthers: number;
    confirmed: number;
    confirmedOthers: number;
    refused: number;
}

/**
 * A performer and a face group, with the counts that decide it, and its untagged items split by
 * kind: Review › Faces opens on videos, and photos wait behind its kind control (§5f).
 */
export interface ReviewEvidenceRow extends GroupEvidenceRow {
    tagId: string;
    untaggedVideos: number;
    untaggedPhotos: number;
}

/**
 * Every pair of a performer and a face group that might be them, with the same counts as
 * `groupsForPerformer`, across the whole library: what Review › Faces is drawn from (§5f). A pair
 * is a group on one of the performer's single-performer items, or holding a face confirmed as
 * them. Given `groupIds`, the pairs of only those groups -- every performer's, so whether a group
 * is anybody's can still be told.
 */
export const groupEvidence = (
    rootIds: readonly string[],
    groupIds?: readonly string[]
): ReviewEvidenceRow[] => {
    if (groupIds?.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = {};
    const where = visible(rootIds, params);
    const only = inGroups(groupIds, params);
    const untagged = `NOT ${carries('f."mediaId"', 'p."tagId"')} AND NOT EXISTS (
                        SELECT 1 FROM "FaceRefusal" r
                         WHERE r."faceId" = f."id" AND r."tagId" = p."tagId"
                    ) AND f."skippedAt" IS NULL`;

    return db
        .prepare(
            `WITH "single" AS MATERIALIZED (${singlePerformer(only.media)}),
                  "pair" AS (
                      SELECT DISTINCT s."tagId", f."groupId"
                        FROM "Face" f JOIN "single" s ON s."mediaId" = f."mediaId"
                       WHERE f."groupId" IS NOT NULL ${only.faces}
                      UNION
                      SELECT DISTINCT f."tagId", f."groupId" FROM "Face" f
                       WHERE f."tagId" IS NOT NULL AND f."groupId" IS NOT NULL ${only.faces}
                         AND NOT EXISTS (SELECT 1 FROM "PerformerNoFace" nf
                                          WHERE nf."tagId" = f."tagId")
                  )
             SELECT p."tagId", p."groupId",
                    count(*) AS "faceCount",
                    count(DISTINCT f."mediaId") AS "itemCount",
                    count(DISTINCT CASE WHEN ${untagged} THEN f."mediaId" END) AS "untaggedCount",
                    count(DISTINCT CASE WHEN ${untagged} AND m."kind" = 'video'
                                        THEN f."mediaId" END) AS "untaggedVideos",
                    count(DISTINCT CASE WHEN ${untagged} AND m."kind" = 'image'
                                        THEN f."mediaId" END) AS "untaggedPhotos",
                    count(DISTINCT CASE WHEN s."tagId" = p."tagId" THEN f."mediaId" END) AS "taggedAsThem",
                    count(DISTINCT CASE WHEN s."tagId" <> p."tagId" THEN f."mediaId" END) AS "taggedAsOthers",
                    count(DISTINCT CASE WHEN f."tagId" = p."tagId" THEN f."mediaId" END) AS "confirmed",
                    count(DISTINCT CASE WHEN f."tagId" IS NOT NULL AND f."tagId" <> p."tagId"
                                        THEN f."mediaId" END) AS "confirmedOthers",
                    count(DISTINCT CASE WHEN EXISTS (
                        SELECT 1 FROM "FaceRefusal" r WHERE r."faceId" = f."id" AND r."tagId" = p."tagId"
                    ) THEN f."mediaId" END) AS "refused"
               FROM "pair" p
               ${only.join} "Face" f ON f."groupId" = p."groupId"
               ${only.join} "Media" m ON m."id" = f."mediaId"
               LEFT JOIN "single" s ON s."mediaId" = f."mediaId"
              WHERE ${where}
              GROUP BY p."tagId", p."groupId"`
        )
        .all(params) as ReviewEvidenceRow[];
};

/** A face nobody's, not skipped, and refused for somebody: left over in a mixed group. */
const LEFT_OVER = `f."tagId" IS NULL AND f."skippedAt" IS NULL
                AND EXISTS (SELECT 1 FROM "FaceRefusal" r WHERE r."faceId" = f."id")`;

/** A face group's size, and how much of it somebody said they "can't tell". */
export interface GroupSize {
    groupId: string;
    faceCount: number;
    itemCount: number;
    /**
     * Items with an undecided face in the group: nobody's, and nobody said "can't tell" of it.
     * What Unnamed may still ask about — a face already named is never asked about again, however
     * the rest of its group was decided.
     */
    openItems: number;
    /** Items with a face in the group somebody skipped. */
    skippedItems: number;
    /**
     * Items with a face left over: nobody's, not skipped, and refused for somebody — what is
     * left of a group that held two people once one of them was named.
     */
    leftItems: number;
    /** How tightly its faces hold together, as the grouping job last measured; null before. */
    cohesion: number | null;
    /** `openItems` and `leftItems` of videos and of photos, for the review's kind control. */
    openVideos: number;
    openPhotos: number;
    leftVideos: number;
    leftPhotos: number;
}

/**
 * Every face group on at least `minItems` items this viewer can see, with its size; of only
 * `groupIds`, given them.
 */
export const groupSizes = (
    rootIds: readonly string[],
    minItems: number,
    groupIds?: readonly string[]
): GroupSize[] => {
    if (groupIds?.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { minItems };
    const where = visible(rootIds, params);
    const only = inGroups(groupIds, params);
    const open = `f."skippedAt" IS NULL AND f."tagId" IS NULL`;

    return db
        .prepare(
            `SELECT f."groupId", count(*) AS "faceCount",
                    (SELECT st."cohesion" FROM "FaceGroupStat" st WHERE st."groupId" = f."groupId") AS "cohesion", count(DISTINCT f."mediaId") AS "itemCount",
                    count(DISTINCT CASE WHEN ${open} THEN f."mediaId" END) AS "openItems",
                    count(DISTINCT CASE WHEN ${open} AND m."kind" = 'video' THEN f."mediaId" END) AS "openVideos",
                    count(DISTINCT CASE WHEN ${open} AND m."kind" = 'image' THEN f."mediaId" END) AS "openPhotos",
                    count(DISTINCT CASE WHEN f."skippedAt" IS NOT NULL THEN f."mediaId" END) AS "skippedItems",
                    count(DISTINCT CASE WHEN ${LEFT_OVER} THEN f."mediaId" END) AS "leftItems",
                    count(DISTINCT CASE WHEN ${LEFT_OVER} AND m."kind" = 'video' THEN f."mediaId" END) AS "leftVideos",
                    count(DISTINCT CASE WHEN ${LEFT_OVER} AND m."kind" = 'image' THEN f."mediaId" END) AS "leftPhotos"
               FROM "Face" f ${only.join} "Media" m ON m."id" = f."mediaId"
              WHERE f."groupId" IS NOT NULL AND ${where} ${only.faces}
              GROUP BY f."groupId"
             HAVING count(DISTINCT f."mediaId") >= :minItems`
        )
        .all(params) as GroupSize[];
};

/**
 * "Can't tell", said of a group's faces on these items in the Unnamed review (§5f): the group
 * leaves the list until enough new faces join it. Returns the faces marked.
 */
export const skipFaces = (groupId: string, mediaIds: readonly string[], userId: string): number =>
    db
        .prepare(
            `UPDATE "Face" SET "skippedAt" = CURRENT_TIMESTAMP, "skippedByUserId" = ?,
                    "decisionId" = ?
              WHERE "groupId" = ? AND "skippedAt" IS NULL AND "tagId" IS NULL
                AND "mediaId" IN (SELECT value FROM json_each(?))`
        )
        .run(userId, activeDecision(), groupId, JSON.stringify(mediaIds)).changes;

/** Faces as a list shows them, by id. */
export const shownFaces = (faceIds: readonly string[]): ShownFace[] =>
    db
        .prepare(
            `SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h"
               FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
              WHERE f."id" IN (SELECT value FROM json_each(?))`
        )
        .all(JSON.stringify(faceIds)) as ShownFace[];

/**
 * "Not them", said of an item the rule matched to a performer: the face shown refused as
 * `shown`, the item's other faces whose best match is them as `inferred`. Returns the faces
 * refused.
 */
export const refuseMatchedOnItem = (
    mediaId: string,
    tagId: string,
    shownFaceId: string | null,
    userId: string
): number =>
    db
        .prepare(
            `INSERT OR IGNORE INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "how", "decisionId")
             SELECT f."id", :tagId, :userId,
                    CASE WHEN f."id" = :shown THEN 'shown' ELSE 'inferred' END, :decision
               FROM "Face" f
              WHERE f."mediaId" = :mediaId
                AND (f."id" = :shown
                     OR EXISTS (SELECT 1 FROM "FaceMatch" fm
                                 WHERE fm."faceId" = f."id" AND fm."tagId" = :tagId))`
        )
        .run({ mediaId, tagId, shown: shownFaceId, userId, decision: activeDecision() }).changes;

/** "That's them", said of one face on screen. Returns whether it was confirmed. */
export const confirmFace = (faceId: string, tagId: string, userId: string): number =>
    db
        .prepare(
            `UPDATE "Face"
                SET "tagId" = ?, "decidedByUserId" = ?, "decidedAt" = CURRENT_TIMESTAMP,
                    "decidedHow" = 'shown', "decisionId" = ?
              WHERE "id" = ? AND "tagId" IS NULL`
        )
        .run(tagId, userId, activeDecision(), faceId).changes;

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
 * For each face group, each performer enough of its faces look like (§5f "One face, one score"):
 * how many of its visible items have a face whose best match is them, at least `line` alike and
 * `margin` more than like anybody else.
 */
export const groupLikenesses = (
    rootIds: readonly string[],
    line: number,
    margin: number,
    groupIds?: readonly string[]
): { groupId: string; tagId: string; items: number }[] => {
    if (groupIds?.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { line, margin };
    const where = visible(rootIds, params);
    const only = inGroups(groupIds, params);

    return db
        .prepare(
            `SELECT f."groupId", fm."tagId", count(DISTINCT f."mediaId") AS "items"
               FROM "Face" f
               ${only.join} "FaceMatch" fm ON fm."faceId" = f."id"
               ${only.join} "Media" m ON m."id" = f."mediaId"
              WHERE f."groupId" IS NOT NULL AND fm."score" >= :line
                AND fm."score" - fm."second" >= :margin AND ${where} ${only.faces}
              GROUP BY f."groupId", fm."tagId"`
        )
        .all(params) as { groupId: string; tagId: string; items: number }[];
};

/**
 * Untagged items with a face that looks like the performer — best match them, at least `line`
 * alike and `margin` more than anybody else, not refused for them or set aside — with that face:
 * face evidence that reaches faces in no group (§5f "One face, one score").
 */
export const untaggedLookingLike = (
    tagId: string,
    rootIds: readonly string[],
    line: number,
    margin: number
): ShownFace[] => {
    const params: Record<string, unknown> = { tagId, line, margin };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT "id", "mediaId", "kind", "atMs", "x", "y", "w", "h" FROM (
                 SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        row_number() OVER (PARTITION BY f."mediaId" ORDER BY fm."score" DESC) AS "n"
                   FROM "FaceMatch" fm
                   JOIN "Face" f ON f."id" = fm."faceId"
                   JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE fm."tagId" = :tagId AND fm."score" >= :line
                    AND fm."score" - fm."second" >= :margin AND ${where}
                    AND f."skippedAt" IS NULL AND f."scatteredAt" IS NULL
                    AND NOT ${carries('f."mediaId"', ":tagId")}
                    AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                     WHERE r."faceId" = f."id" AND r."tagId" = :tagId)
             ) WHERE "n" = 1`
        )
        .all(params) as ShownFace[];
};

/**
 * A performer's face as their tagged items show it, where nobody has confirmed one: faces on
 * items carrying them whose best match is them, the surest first, one an item.
 */
export const faceFromTags = (
    tagId: string,
    rootIds: readonly string[],
    limit: number
): ShownFace[] => {
    const params: Record<string, unknown> = { tagId, limit };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT "id", "mediaId", "kind", "atMs", "x", "y", "w", "h" FROM (
                 SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        fm."score",
                        row_number() OVER (PARTITION BY f."mediaId" ORDER BY fm."score" DESC) AS "n"
                   FROM "FaceMatch" fm
                   JOIN "Face" f ON f."id" = fm."faceId"
                   JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE fm."tagId" = :tagId AND ${where}
                    AND EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = f."mediaId" AND mt."tagId" = :tagId)
             ) WHERE "n" = 1 ORDER BY "score" DESC LIMIT :limit`
        )
        .all(params) as ShownFace[];
};

/** Every pair of a group and a performer some of its faces were refused for; of `groupIds`, given. */
export const groupRefusals = (
    groupIds?: readonly string[]
): { groupId: string; tagId: string }[] => {
    if (groupIds?.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = {};
    const only = inGroups(groupIds, params);

    return db
        .prepare(
            `SELECT DISTINCT f."groupId", r."tagId"
               FROM "FaceRefusal" r JOIN "Face" f ON f."id" = r."faceId"
              WHERE f."groupId" IS NOT NULL ${only.faces}`
        )
        .all(params) as { groupId: string; tagId: string }[];
};

/**
 * A performer's largest and surest confirmed faces, whichever groups they are in, one an item:
 * "Their face" on their page (§5f).
 */
export const confirmedFaces = (
    tagId: string,
    rootIds: readonly string[],
    limit: number
): ShownFace[] => {
    const params: Record<string, unknown> = { tagId, limit };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT "id", "mediaId", "kind", "atMs", "x", "y", "w", "h" FROM (
                 SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        row_number() OVER (PARTITION BY f."mediaId"
                                           ORDER BY f."score" * f."eyes" DESC) AS "n",
                        f."score" * f."eyes" AS "weight"
                   FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE f."tagId" = :tagId AND ${where}
             ) WHERE "n" = 1 ORDER BY "weight" DESC LIMIT :limit`
        )
        .all(params) as ShownFace[];
};

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

/** Where each face's vector is: its item's faces file, at its index. */
export const vectorRefs = (
    faceIds: readonly string[]
): { id: string; mediaId: string; vectorIndex: number; groupId: string | null }[] =>
    db
        .prepare(
            `SELECT "id", "mediaId", "vectorIndex", "groupId" FROM "Face"
              WHERE "id" IN (SELECT value FROM json_each(?))`
        )
        .all(JSON.stringify(faceIds)) as {
        id: string;
        mediaId: string;
        vectorIndex: number;
        groupId: string | null;
    }[];

/** An item's faces in a group, largest and surest first: other moments of the same person. */
export const itemFacesInGroup = (
    groupId: string,
    mediaId: string,
    rootIds: readonly string[],
    limit: number
): ShownFace[] => {
    const params: Record<string, unknown> = { groupId, mediaId, limit };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h"
               FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
              WHERE f."groupId" = :groupId AND f."mediaId" = :mediaId AND ${where}
              ORDER BY f."score" * f."eyes" DESC
              LIMIT :limit`
        )
        .all(params) as ShownFace[];
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
     * face that does not -- the last resort, cut at a smaller size.
     */
    tier: 1 | 2 | 3;
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
 */
export const pictureCandidates = (
    minScore: number,
    minShare: number,
    perTier: number
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
        .all({ minScore, minShare, perTier }) as PictureCandidate[];

/** A group's largest and surest faces, on items this viewer can see, one an item. */
export const sampleFaces = (
    groupId: string,
    rootIds: readonly string[],
    limit: number,
    /**
     * `open`: only faces nobody said "can't tell" of — what is new in a group that was skipped.
     * `left`: only faces left over once somebody else in the group was named (`GroupSize`).
     */
    only: "all" | "open" | "left" = "all",
    /** Faces on videos, or on photos, only; both when absent. */
    media?: MediaKind
): ShownFace[] => {
    const params: Record<string, unknown> = { groupId, limit, media: media ?? null };
    const where = `${visible(rootIds, params)}${
        only === "open"
            ? ` AND f."skippedAt" IS NULL AND f."tagId" IS NULL`
            : only === "left"
              ? ` AND ${LEFT_OVER}`
              : ""
    } AND (:media IS NULL OR m."kind" = :media)`;

    return db
        .prepare(
            `SELECT "id", "mediaId", "kind", "atMs", "x", "y", "w", "h" FROM (
                 SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        row_number() OVER (PARTITION BY f."mediaId"
                                           ORDER BY f."score" * f."eyes" DESC) AS "n",
                        f."score" * f."eyes" AS "weight"
                   FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE f."groupId" = :groupId AND ${where}
             ) WHERE "n" = 1 ORDER BY "weight" DESC LIMIT :limit`
        )
        .all(params) as ShownFace[];
};

/** `?` ids as a JSON array, for `json_each`. */
const ids = (values: readonly string[]): string => JSON.stringify(values);

/** How a face was decided, by whether it was among those shown. */
const howSql = (otherwise: DecidedHow): string =>
    `CASE WHEN "id" IN (SELECT value FROM json_each(:shown)) THEN 'shown' ELSE '${otherwise}' END`;

/**
 * "That's them" or "Not them", said of a group (§5f).
 *
 * Confirming confirms the faces that were shown, and only those: a group confirmed whole from six
 * samples used to label every face in it, unseen, and counted as looked at. Refusing takes back
 * any confirmation of them in the group and refuses its faces — not those on items already
 * carrying them, which their tags vouch for and nobody was asked about. Returns the faces changed.
 */
export const decideGroup = (
    groupId: string,
    tagId: string,
    verdict: "confirm" | "refuse",
    userId: string,
    shownFaceIds: readonly string[]
): number =>
    db.transaction((): number => {
        const params = {
            tagId,
            userId,
            groupId,
            shown: ids(shownFaceIds),
            decision: activeDecision(),
        };

        if (verdict === "confirm") {
            return db
                .prepare(
                    `UPDATE "Face"
                        SET "tagId" = :tagId, "decidedByUserId" = :userId,
                            "decidedAt" = CURRENT_TIMESTAMP, "decidedHow" = 'shown',
                            "decisionId" = :decision
                      WHERE "groupId" = :groupId AND "tagId" IS NULL
                        AND "id" IN (SELECT value FROM json_each(:shown))
                        AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                         WHERE r."faceId" = "Face"."id" AND r."tagId" = :tagId)`
                )
                .run(params).changes;
        }

        db.prepare(
            `UPDATE "Face"
                SET "tagId" = NULL, "decidedByUserId" = :userId, "decidedAt" = CURRENT_TIMESTAMP,
                    "decidedHow" = NULL, "decisionId" = NULL
              WHERE "groupId" = :groupId AND "tagId" = :tagId`
        ).run({ tagId, userId, groupId });

        return db
            .prepare(
                `INSERT OR IGNORE INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "how", "decisionId")
                 SELECT "id", :tagId, :userId, ${howSql("inferred")}, :decision FROM "Face"
                  WHERE "groupId" = :groupId
                    AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                     WHERE mt."mediaId" = "Face"."mediaId" AND mt."tagId" = :tagId)`
            )
            .run(params).changes;
    })();

/**
 * "That's them", said of some items' faces in a group: the ones not refused for the performer
 * and not already somebody's. Returns the faces changed.
 */
export const confirmOnItems = (
    groupId: string,
    tagId: string,
    mediaIds: readonly string[],
    userId: string,
    /** The faces that were on screen: confirmed as `shown`, the item's others as `inferred`. */
    shownFaceIds: readonly string[] = []
): number =>
    db
        .prepare(
            `UPDATE "Face"
                SET "tagId" = :tagId, "decidedByUserId" = :userId, "decidedAt" = CURRENT_TIMESTAMP,
                    "decidedHow" = ${howSql("inferred")}, "decisionId" = :decision
              WHERE "groupId" = :groupId AND "tagId" IS NULL
                AND "mediaId" IN (SELECT value FROM json_each(:mediaIds))
                AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                 WHERE r."faceId" = "Face"."id" AND r."tagId" = :tagId)`
        )
        .run({
            tagId,
            userId,
            groupId,
            mediaIds: ids(mediaIds),
            shown: ids(shownFaceIds),
            decision: activeDecision(),
        }).changes;

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

/**
 * "Them after all", said of items' faces in a group that were refused for the performer: the
 * leftovers of a mixed group, named as the person they were unticked for. Returns the refusals
 * withdrawn.
 */
export const withdrawRefusals = (
    groupId: string,
    tagId: string,
    mediaIds: readonly string[]
): number =>
    db
        .prepare(
            `DELETE FROM "FaceRefusal"
              WHERE "tagId" = ?
                AND "faceId" IN (SELECT "id" FROM "Face"
                                  WHERE "groupId" = ? AND "mediaId" IN (SELECT value FROM json_each(?)))`
        )
        .run(tagId, groupId, JSON.stringify(mediaIds)).changes;

/** "Not them", said of one item's faces in these groups. Returns the faces refused. */
export const refuseOnItem = (
    mediaId: string,
    tagId: string,
    groupIds: readonly string[],
    userId: string,
    /** The faces that were on screen, refused as `shown`; the rest as `otherwise`. */
    shownFaceIds: readonly string[] = [],
    otherwise: DecidedHow = "inferred"
): number => {
    if (groupIds.length === 0) {
        return 0;
    }

    return db
        .prepare(
            `INSERT OR IGNORE INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "how", "decisionId")
             SELECT "id", :tagId, :userId, ${howSql(otherwise)}, :decision FROM "Face"
              WHERE "mediaId" = :mediaId AND "groupId" IN (SELECT value FROM json_each(:groups))`
        )
        .run({
            tagId,
            userId,
            mediaId,
            groups: ids(groupIds),
            shown: ids(shownFaceIds),
            decision: activeDecision(),
        }).changes;
};

/**
 * Items not yet carrying the performer whose faces are in these groups, with the face to show
 * for each: the largest and surest of its faces there, not refused for the performer.
 */
export const untaggedInGroups = (
    groupIds: readonly string[],
    tagId: string,
    rootIds: readonly string[]
): (ShownFace & { groupId: string })[] => {
    if (groupIds.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { tagId, groups: JSON.stringify(groupIds) };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT "id", "mediaId", "kind", "atMs", "x", "y", "w", "h", "groupId" FROM (
                 SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        f."groupId",
                        row_number() OVER (PARTITION BY f."mediaId"
                                           ORDER BY f."score" * f."eyes" DESC) AS "n",
                        f."score" * f."eyes" AS "weight"
                   FROM "Face" f CROSS JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE f."groupId" IN (SELECT value FROM json_each(:groups)) AND ${where}
                    AND NOT ${carries('f."mediaId"', ":tagId")}
                    AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                     WHERE r."faceId" = f."id" AND r."tagId" = :tagId)
                    AND f."skippedAt" IS NULL
             ) WHERE "n" = 1 ORDER BY "weight" DESC, "mediaId"`
        )
        .all(params) as (ShownFace & { groupId: string })[];
};

/** How many untagged items a pair of a group and a performer has, of each kind. */
export interface UntaggedCount {
    groupId: string;
    tagId: string;
    items: number;
    videos: number;
    photos: number;
}

/**
 * For each pair of a group and a performer, the items with a face there not carrying the
 * performer, not refused for them or set aside, counted and split by kind: what
 * `untaggedInGroups` lists, for many pairs in one read.
 */
export const untaggedCounts = (
    pairs: readonly { groupId: string; tagId: string }[],
    rootIds: readonly string[]
): UntaggedCount[] => {
    if (pairs.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = {
        pairs: JSON.stringify(pairs.map((pair) => [pair.groupId, pair.tagId])),
    };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `WITH "pair" AS (
                 SELECT json_extract(value, '$[0]') AS "groupId",
                        json_extract(value, '$[1]') AS "tagId"
                   FROM json_each(:pairs)
             )
             SELECT p."groupId", p."tagId",
                    count(DISTINCT f."mediaId") AS "items",
                    count(DISTINCT CASE WHEN m."kind" = 'video' THEN f."mediaId" END) AS "videos",
                    count(DISTINCT CASE WHEN m."kind" = 'image' THEN f."mediaId" END) AS "photos"
               FROM "pair" p
               CROSS JOIN "Face" f ON f."groupId" = p."groupId"
               CROSS JOIN "Media" m ON m."id" = f."mediaId"
              WHERE ${where} AND f."skippedAt" IS NULL
                AND NOT ${carries('f."mediaId"', 'p."tagId"')}
                AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r
                                 WHERE r."faceId" = f."id" AND r."tagId" = p."tagId")
              GROUP BY p."groupId", p."tagId"`
        )
        .all(params) as UntaggedCount[];
};

/**
 * A group's largest and surest faces on items already carrying the performer, one an item: what
 * the faces being decided about are compared with.
 */
export const taggedInGroup = (
    groupId: string,
    tagId: string,
    rootIds: readonly string[],
    limit: number
): ShownFace[] => {
    const params: Record<string, unknown> = { groupId, tagId, limit };
    const where = visible(rootIds, params);

    return db
        .prepare(
            `SELECT "id", "mediaId", "kind", "atMs", "x", "y", "w", "h" FROM (
                 SELECT f."id", f."mediaId", m."kind", f."atMs", f."x", f."y", f."w", f."h",
                        row_number() OVER (PARTITION BY f."mediaId"
                                           ORDER BY f."score" * f."eyes" DESC) AS "n",
                        f."score" * f."eyes" AS "weight"
                   FROM "Face" f JOIN "Media" m ON m."id" = f."mediaId"
                  WHERE f."groupId" = :groupId AND ${where}
                    AND EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = f."mediaId" AND mt."tagId" = :tagId)
             ) WHERE "n" = 1 ORDER BY "weight" DESC LIMIT :limit`
        )
        .all(params) as ShownFace[];
};
