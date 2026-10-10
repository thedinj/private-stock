import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * Face decisions as acts (§5f "Decisions you can take back"): one `FaceDecision` a press, and
 * every row the press wrote pointing at it.
 *
 * A press is recorded around the writes it makes (`record`): while it runs, every face write —
 * a confirmation, a refusal, a can't-tell, a not-one-person, an item refused, the tag batch it
 * makes — reads `activeDecision()` and is stamped with it. Writes made by nothing recorded carry
 * no decision, as before. Synchronous, as better-sqlite3 is, so one press can never see another's.
 */

export type DecisionVerdict = "is" | "isNot" | "notOnePerson" | "later";

export type DecisionSurface =
    | "review"
    | "performer"
    | "item"
    | "wouldTag"
    | "untag"
    | "findUntagged"
    | "auto"
    | "history"
    | "earlier";

export interface NewDecision {
    actor: "user" | "app";
    userId: string | null;
    verdict: DecisionVerdict;
    tagId: string | null;
    surface: DecisionSurface;
}

let active: string | null = null;

/** The press being recorded, for the writes it makes to point at; null outside one. */
export const activeDecision = (): string | null => active;

/** What a press wrote: how many faces and items. */
const tally = (decisionId: string): { faceCount: number; itemCount: number; batch: boolean } =>
    db
        .prepare(
            `SELECT (SELECT count(*) FROM "Face" WHERE "decisionId" = :id) +
                    (SELECT count(*) FROM "FaceRefusal" WHERE "decisionId" = :id) AS "faceCount",
                    (SELECT count(DISTINCT "mediaId") FROM (
                        SELECT "mediaId" FROM "Face" WHERE "decisionId" = :id
                        UNION ALL
                        SELECT f."mediaId" FROM "FaceRefusal" r JOIN "Face" f ON f."id" = r."faceId"
                         WHERE r."decisionId" = :id
                        UNION ALL
                        SELECT "mediaId" FROM "ItemRefusal" WHERE "decisionId" = :id
                        UNION ALL
                        SELECT mt."mediaId" FROM "MediaTag" mt
                          JOIN "FaceDecision" d ON d."tagBatchId" = mt."batchId"
                         WHERE d."id" = :id)) AS "itemCount",
                    (SELECT "tagBatchId" IS NOT NULL FROM "FaceDecision" WHERE "id" = :id) AS "batch"`
        )
        .get({ id: decisionId }) as { faceCount: number; itemCount: number; batch: boolean };

/**
 * Record one press around the writes it makes. Inside another press, it is part of that one:
 * a refusal from an item's page that also untags is one act, undone as one. A press that wrote
 * nothing leaves no decision behind. Returns the decision, if one was kept, and what `write`
 * returned.
 */
export const record = <T>(
    decision: NewDecision,
    write: () => T
): { decisionId: string | null; result: T } => {
    if (active !== null) {
        return { decisionId: active, result: write() };
    }

    return db.transaction(() => {
        const id = randomUUID();

        db.prepare(
            `INSERT INTO "FaceDecision" ("id", "actor", "userId", "verdict", "tagId", "surface")
             VALUES (@id, @actor, @userId, @verdict, @tagId, @surface)`
        ).run({ id, ...decision });

        active = id;

        let result: T;

        try {
            result = write();
        } finally {
            active = null;
        }

        const { faceCount, itemCount, batch } = tally(id);

        if (faceCount === 0 && itemCount === 0 && !batch) {
            db.prepare(`DELETE FROM "FaceDecision" WHERE "id" = ?`).run(id);

            return { decisionId: null, result };
        }

        db.prepare(`UPDATE "FaceDecision" SET "faceCount" = ?, "itemCount" = ? WHERE "id" = ?`).run(
            faceCount,
            itemCount,
            id
        );

        return { decisionId: id, result };
    })();
};

/** Who the press being recorded is about, once it is known: a name typed may coin them. */
export const nameActive = (tagId: string): void => {
    if (active === null) return;

    db.prepare(`UPDATE "FaceDecision" SET "tagId" = ? WHERE "id" = ?`).run(tagId, active);
};

/** The tag batch a press made: called by the batch writer while a press is being recorded. */
export const attachBatch = (batchId: string): void => {
    if (active === null) return;

    db.prepare(
        `UPDATE "FaceDecision" SET "tagBatchId" = coalesce("tagBatchId", ?) WHERE "id" = ?`
    ).run(batchId, active);
};

/** One decision, as History lists it. */
export interface DecisionRow {
    id: string;
    actor: "user" | "app";
    userId: string | null;
    verdict: DecisionVerdict;
    tagId: string | null;
    tagName: string | null;
    surface: DecisionSurface;
    tagBatchId: string | null;
    faceCount: number;
    itemCount: number;
    createdAt: string;
    undoneAt: string | null;
}

const COLUMNS = `d."id", d."actor", d."userId", d."verdict", d."tagId", t."name" AS "tagName",
                 d."surface", d."tagBatchId", d."faceCount", d."itemCount", d."createdAt",
                 d."undoneAt"`;

export const find = (id: string): DecisionRow | undefined =>
    db
        .prepare(
            `SELECT ${COLUMNS} FROM "FaceDecision" d LEFT JOIN "Tag" t ON t."id" = d."tagId"
              WHERE d."id" = ?`
        )
        .get(id) as DecisionRow | undefined;

/**
 * Decisions newest first, a page at a time after `before` (a decision's `createdAt` and id),
 * by the people or by the app, and of one performer if given.
 */
export const page = (query: {
    actor: "user" | "app" | null;
    tagId: string | null;
    before: { createdAt: string; id: string } | null;
    limit: number;
}): DecisionRow[] =>
    db
        .prepare(
            `SELECT ${COLUMNS} FROM "FaceDecision" d LEFT JOIN "Tag" t ON t."id" = d."tagId"
              WHERE (:actor IS NULL OR d."actor" = :actor)
                AND (:tagId IS NULL OR d."tagId" = :tagId)
                AND (:beforeAt IS NULL OR d."createdAt" < :beforeAt
                     OR (d."createdAt" = :beforeAt AND d."id" < :beforeId))
              ORDER BY d."createdAt" DESC, d."id" DESC
              LIMIT :limit`
        )
        .all({
            actor: query.actor,
            tagId: query.tagId,
            beforeAt: query.before?.createdAt ?? null,
            beforeId: query.before?.id ?? null,
            limit: query.limit,
        }) as DecisionRow[];

/** A few of the faces a decision still holds, the largest first: what History shows of it. */
export const sampleFaceIds = (decisionId: string, limit: number): string[] =>
    db
        .prepare(
            `SELECT "id" FROM (
                 SELECT f."id", f."h" * f."score" AS "size" FROM "Face" f WHERE f."decisionId" = :id
                 UNION ALL
                 SELECT f."id", f."h" * f."score" FROM "FaceRefusal" r
                   JOIN "Face" f ON f."id" = r."faceId"
                  WHERE r."decisionId" = :id
             ) ORDER BY "size" DESC LIMIT :limit`
        )
        .pluck()
        .all({ id: decisionId, limit }) as string[];

/** The items a decision's tag batch still holds, when its faces say nothing (an app tag). */
export const batchItems = (batchId: string, limit: number): string[] =>
    db
        .prepare(`SELECT "mediaId" FROM "MediaTag" WHERE "batchId" = ? LIMIT ?`)
        .pluck()
        .all(batchId, limit) as string[];

/**
 * Take back what a decision wrote and still holds — its confirmations, can't-tells and
 * not-one-persons cleared, its refusals and items refused deleted — and mark it undone. Rows a
 * later decision has since rewritten belong to that one and stay. The tag batch is the caller's:
 * withdrawing it is a tag change, with its own consequences. Returns what was taken back.
 */
export const undo = (
    decisionId: string,
    userId: string
): { faces: number; refusals: number; items: number; scattered: number } =>
    db.transaction(() => {
        const faces = db
            .prepare(
                `UPDATE "Face"
                    SET "tagId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL,
                        "decidedHow" = NULL, "decisionId" = NULL
                  WHERE "decisionId" = ? AND "tagId" IS NOT NULL`
            )
            .run(decisionId).changes;
        const later = db
            .prepare(
                `UPDATE "Face" SET "skippedAt" = NULL, "skippedByUserId" = NULL, "decisionId" = NULL
                  WHERE "decisionId" = ? AND "skippedAt" IS NOT NULL`
            )
            .run(decisionId).changes;
        const scattered = db
            .prepare(
                `UPDATE "Face" SET "scatteredAt" = NULL, "scatteredByUserId" = NULL, "decisionId" = NULL
                  WHERE "decisionId" = ? AND "scatteredAt" IS NOT NULL`
            )
            .run(decisionId).changes;
        const refusals = db
            .prepare(`DELETE FROM "FaceRefusal" WHERE "decisionId" = ?`)
            .run(decisionId).changes;
        const items = db
            .prepare(`DELETE FROM "ItemRefusal" WHERE "decisionId" = ?`)
            .run(decisionId).changes;

        db.prepare(
            `UPDATE "FaceDecision" SET "undoneAt" = CURRENT_TIMESTAMP, "undoneByUserId" = ?
              WHERE "id" = ?`
        ).run(userId, decisionId);

        return { faces: faces + later, refusals, items, scattered };
    })();
