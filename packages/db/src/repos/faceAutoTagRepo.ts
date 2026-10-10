import { db } from "../db.js";

/**
 * Tagging by itself (§5f "Tagging by itself"): the evidence the rule reads, and what it would tag.
 *
 * The rule itself is `autoTags` in core; this reads, per item and performer, what it needs, and
 * keeps what it says.
 */

/** What one item says about one performer, with its best face. */
export interface AutoTagCandidate {
    mediaId: string;
    tagId: string;
    faceId: string;
    bestScore: number;
    strongFaces: number;
    named: 0 | 1;
    anchorItems: number;
}

/**
 * Every untagged item with a face whose best match is a performer at `line` with `margin`, the
 * evidence counted: faces at distinct moments at `strongLine`, the best score and its face,
 * whether their name is on the item, how many items their reference rests on. Not where the item
 * was refused for them, or a face on it somebody saw — a refusal carried to a face nobody saw no
 * longer speaks for the whole item (§5f "Decisions you can take back") — or a person already
 * checked the pair, or the item carries them.
 */
export const candidates = (line: number, strongLine: number, margin: number): AutoTagCandidate[] =>
    db
        .prepare(
            `SELECT f."mediaId", fm."tagId",
                    (SELECT f2."id" FROM "FaceMatch" fm2 JOIN "Face" f2 ON f2."id" = fm2."faceId"
                      WHERE f2."mediaId" = f."mediaId" AND fm2."tagId" = fm."tagId"
                      ORDER BY fm2."score" DESC LIMIT 1) AS "faceId",
                    max(fm."score") AS "bestScore",
                    count(DISTINCT CASE WHEN fm."score" >= :strongLine
                                        THEN coalesce(f."atMs", f."vectorIndex") END) AS "strongFaces",
                    EXISTS (SELECT 1 FROM "MediaMention" mm
                             WHERE mm."mediaId" = f."mediaId" AND mm."tagId" = fm."tagId"
                               AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" mr
                                                WHERE mr."mediaId" = mm."mediaId"
                                                  AND mr."tagId" = mm."tagId")) AS "named",
                    a."items" AS "anchorItems"
               FROM "FaceMatch" fm
               JOIN "Face" f ON f."id" = fm."faceId"
               JOIN "FaceAnchor" a ON a."tagId" = fm."tagId"
               JOIN "Media" m ON m."id" = f."mediaId" AND m."listable" = 1
              WHERE fm."score" >= :line AND fm."score" - fm."second" >= :margin
                AND f."scatteredAt" IS NULL
                AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = f."mediaId" AND mt."tagId" = fm."tagId")
                AND NOT EXISTS (SELECT 1 FROM "FaceRefusal" r JOIN "Face" rf ON rf."id" = r."faceId"
                                 WHERE rf."mediaId" = f."mediaId" AND r."tagId" = fm."tagId"
                                   AND r."how" IS NOT 'inferred')
                AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" mr
                                 WHERE mr."mediaId" = f."mediaId" AND mr."tagId" = fm."tagId")
                AND NOT EXISTS (SELECT 1 FROM "FaceAutoTag" t
                                 WHERE t."mediaId" = f."mediaId" AND t."tagId" = fm."tagId"
                                   AND t."state" <> 'proposed')
              GROUP BY f."mediaId", fm."tagId"`
        )
        .all({ line, strongLine, margin }) as AutoTagCandidate[];

/** Replace what the rule proposes; what was checked or applied stays. One transaction. */
export const replaceProposals = (rows: readonly Omit<AutoTagCandidate, "anchorItems">[]): void => {
    const insert = db.prepare(
        `INSERT OR IGNORE INTO "FaceAutoTag"
             ("mediaId", "tagId", "faceId", "score", "strongFaces", "named", "state")
         VALUES (@mediaId, @tagId, @faceId, @bestScore, @strongFaces, @named, 'proposed')`
    );

    db.transaction(() => {
        db.prepare(`DELETE FROM "FaceAutoTag" WHERE "state" = 'proposed'`).run();

        for (const row of rows) insert.run({ ...row, named: row.named === 1 ? 1 : null });
    })();
};

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
