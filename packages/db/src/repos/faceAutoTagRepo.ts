import { db } from "../db.js";

/**
 * Tagging by itself (§5f "Tagging by itself"): the evidence the rule reads, and what it would tag.
 *
 * The rule itself is `autoTags` in core; this reads, per person in an item and performer, what it
 * needs, and keeps what it says.
 */

/** What one person in an item says about one performer, with their clearest face. */
export interface AutoTagCandidate {
    mediaId: string;
    tagId: string;
    faceId: string;
    kind: "video" | "image";
    /** Their faces together against the performer's reference. */
    bestScore: number;
    /** How many of the item's faces are this person. */
    strongFaces: number;
    named: 0 | 1;
    anchorItems: number;
}

/**
 * Every legible person in an untagged item whose best match is a performer at `line` with
 * `margin` (§5f "Tagging by itself"), the surest person an item and performer, with what the rule
 * reads: how often they are seen, their score, whether their name is on the item, how many items
 * the reference rests on. Not where the item was refused for them, or a face of the person was
 * confirmed as anybody or refused for them by somebody who saw it, or a person already checked or
 * the app already tagged the pair, or the item carries them.
 */
export const candidates = (line: number, margin: number): AutoTagCandidate[] =>
    db
        .prepare(
            `SELECT "mediaId", "tagId", "faceId", "kind", "bestScore", "strongFaces", "named", "anchorItems"
               FROM (
                 SELECT a."mediaId", a."matchTagId" AS "tagId", a."bestFaceId" AS "faceId", m."kind",
                        a."score" AS "bestScore", a."faceCount" AS "strongFaces",
                        EXISTS (SELECT 1 FROM "MediaMention" mm
                                 WHERE mm."mediaId" = a."mediaId" AND mm."tagId" = a."matchTagId") AS "named",
                        an."items" AS "anchorItems",
                        row_number() OVER (PARTITION BY a."mediaId", a."matchTagId"
                                           ORDER BY a."score" DESC) AS "n"
                   FROM "FaceAppearance" a
                   JOIN "FaceAnchor" an ON an."tagId" = a."matchTagId"
                   JOIN "Media" m ON m."id" = a."mediaId" AND m."listable" = 1
                  WHERE a."legible" = 1 AND a."score" >= :line AND a."score" - a."second" >= :margin
                    AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                     WHERE mt."mediaId" = a."mediaId" AND mt."tagId" = a."matchTagId")
                    AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" ir
                                     WHERE ir."mediaId" = a."mediaId" AND ir."tagId" = a."matchTagId")
                    AND NOT EXISTS (SELECT 1 FROM "Face" f
                                     WHERE f."appearanceId" = a."id"
                                       AND (f."tagId" IS NOT NULL
                                            OR EXISTS (SELECT 1 FROM "FaceRefusal" r
                                                        WHERE r."faceId" = f."id"
                                                          AND r."tagId" = a."matchTagId"
                                                          AND r."how" IS NOT 'inferred')))
                    AND NOT EXISTS (SELECT 1 FROM "FaceAutoTag" t
                                     WHERE t."mediaId" = a."mediaId" AND t."tagId" = a."matchTagId"
                                       AND t."state" <> 'proposed')
               ) WHERE "n" = 1`
        )
        .all({ line, margin }) as AutoTagCandidate[];

/** Replace what the rule proposes, as `rule`; what was checked or applied stays. One transaction. */
export const replaceProposals = (
    rows: readonly Omit<AutoTagCandidate, "anchorItems" | "kind">[],
    rule: number
): void => {
    const insert = db.prepare(
        `INSERT OR IGNORE INTO "FaceAutoTag"
             ("mediaId", "tagId", "faceId", "score", "strongFaces", "named", "state", "rule")
         VALUES (@mediaId, @tagId, @faceId, @bestScore, @strongFaces, @named, 'proposed', @rule)`
    );

    db.transaction(() => {
        db.prepare(`DELETE FROM "FaceAutoTag" WHERE "state" = 'proposed'`).run();

        for (const row of rows) insert.run({ ...row, named: row.named === 1 ? 1 : null, rule });
    })();
};

/** How a rule's own proposals were checked: what lets it tag by itself (§5f). */
export const trial = (rule: number): { right: number; wrong: number } =>
    db
        .prepare(
            `SELECT coalesce(sum("state" = 'right'), 0) AS "right",
                    coalesce(sum("state" = 'wrong'), 0) AS "wrong"
               FROM "FaceAutoTag" WHERE "rule" = ?`
        )
        .get(rule) as { right: number; wrong: number };

/** A pair the rule proposed, with what it read. */
export interface AutoTagRow {
    mediaId: string;
    tagId: string;
    faceId: string | null;
    score: number;
    strongFaces: number;
    named: 1 | null;
    state: "proposed" | "right" | "wrong" | "applied" | "removed";
    decidedAt: string | null;
}

/** Every pair in a state, on items this viewer can see. */
export const inState = (state: AutoTagRow["state"], rootIds: readonly string[]): AutoTagRow[] => {
    if (rootIds.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { state };

    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    return db
        .prepare(
            `SELECT t."mediaId", t."tagId", t."faceId", t."score", t."strongFaces", t."named", t."state",
                    t."decidedAt"
               FROM "FaceAutoTag" t JOIN "Media" m ON m."id" = t."mediaId"
              WHERE t."state" = :state AND m."listable" = 1
                AND m."listRootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})
              ORDER BY t."decidedAt" DESC`
        )
        .all(params) as AutoTagRow[];
};

/** How many pairs are in each state. */
export const counts = (): Record<AutoTagRow["state"], number> => {
    const out = { proposed: 0, right: 0, wrong: 0, applied: 0, removed: 0 };

    for (const row of db
        .prepare(`SELECT "state", count(*) AS "n" FROM "FaceAutoTag" GROUP BY "state"`)
        .all() as { state: AutoTagRow["state"]; n: number }[]) {
        out[row.state] = row.n;
    }

    return out;
};

/** One pair, if the rule has a row for it. */
export const find = (mediaId: string, tagId: string): AutoTagRow | undefined =>
    db
        .prepare(
            `SELECT "mediaId", "tagId", "faceId", "score", "strongFaces", "named", "state",
                    "decidedAt"
               FROM "FaceAutoTag" WHERE "mediaId" = ? AND "tagId" = ?`
        )
        .get(mediaId, tagId) as AutoTagRow | undefined;

/**
 * Tags made by faces that somebody took back, by whatever path: how the rule is measured once it
 * acts. Returns the pairs marked.
 */
export const markRemoved = (mediaIds: readonly string[], tagId: string, userId: string): number =>
    db
        .prepare(
            `UPDATE "FaceAutoTag"
                SET "state" = 'removed', "decidedByUserId" = ?, "decidedAt" = CURRENT_TIMESTAMP
              WHERE "tagId" = ? AND "state" = 'applied'
                AND "mediaId" IN (SELECT value FROM json_each(?))`
        )
        .run(userId, tagId, JSON.stringify(mediaIds)).changes;

/** Say what became of a pair. */
export const decide = (
    mediaId: string,
    tagId: string,
    state: "right" | "wrong" | "applied",
    userId: string | null
): number =>
    db
        .prepare(
            `UPDATE "FaceAutoTag"
                SET "state" = ?, "decidedByUserId" = ?, "decidedAt" = CURRENT_TIMESTAMP
              WHERE "mediaId" = ? AND "tagId" = ?`
        )
        .run(state, userId, mediaId, tagId).changes;
