import { randomUUID } from "node:crypto";

import { db } from "../db.js";
import { pruneUnused } from "./tagRepo.js";

/**
 * Bulk tagging operations, and the undo that makes them safe to attempt (§5d).
 *
 * The whole feature rests on one property: a batch can be withdrawn without touching anything
 * a person typed. That is why the write goes through here rather than through repeated
 * `tagRepo.assign` calls — the rows have to carry the batch that created them, and they have
 * to be created in one transaction so an interrupted apply leaves either all of it or none.
 */

export interface TagBatchRow {
    id: string;
    userId: string;
    summary: string;
    mediaCount: number;
    /** Set for a batch of clips (§14d), whose `mediaCount` is 0; null for a batch of items. */
    clipCount: number | null;
    createdAt: string;
    undoneAt: string | null;
}

export interface ApplyBatchInput {
    /** Who did it. Always a real person -- a batch is somebody's action, and undoable by them. */
    userId: string;
    /**
     * Who the assignments are for: null for the whole library, a user id for one person.
     *
     * Distinct from `userId` on purpose: one says who acted, the other which of the two
     * tagging systems was written to (§6). Reusing one column for both would make every bulk
     * apply private, including the administrator's.
     *
     * Required, with no default. It used to default to the library, which is a silent publish
     * now that anybody can address either system.
     */
    scope: string | null;
    summary: string;
    mediaIds: string[];
    tagIds: string[];
}

export interface ApplyBatchResult {
    batchId: string;
    /** Rows actually written — items that already carried the tag are not among them. */
    assigned: number;
}

/**
 * Applies tags to many items as one undoable operation.
 *
 * `INSERT OR IGNORE` leaves an existing assignment exactly as it is, which is what makes undo
 * safe: an item somebody had already tagged by hand keeps that row, the row never joins this
 * batch, and withdrawing the batch cannot take it away.
 */
export const apply = (input: ApplyBatchInput): ApplyBatchResult =>
    applyAssignments({
        userId: input.userId,
        scope: input.scope,
        summary: input.summary,
        assignments: input.mediaIds.flatMap((mediaId) =>
            input.tagIds.map((tagId) => ({ mediaId, tagId }))
        ),
    });

export interface ApplyAssignmentsInput extends Omit<ApplyBatchInput, "mediaIds" | "tagIds"> {
    assignments: { mediaId: string; tagId: string }[];
    /**
     * What made the rows: a person (`user`), or faces tagging by themselves (`ai`, §5f "Tagging
     * by itself") — which nothing that proposes or builds a reference may read back as evidence.
     */
    source?: "user" | "ai";
}

/**
 * `apply` for when each tag goes to a different set of items: accepting several OCR matches at
 * once (§5d), where each tag is owed only to the items that do not carry it yet and were not
 * left out of it. One batch, so one undo, all the same.
 */
export const applyAssignments = (input: ApplyAssignmentsInput): ApplyBatchResult =>
    db.transaction((): ApplyBatchResult => {
        const batchId = randomUUID();
        const mediaCount = new Set(input.assignments.map(({ mediaId }) => mediaId)).size;

        db.prepare(
            `INSERT INTO "TagBatch" ("id", "userId", "summary", "mediaCount")
             VALUES (?, ?, ?, ?)`
        ).run(batchId, input.userId, input.summary, mediaCount);

        const insert = db.prepare(
            // `scope` is the assignment's audience: NULL is library-wide, a user id is that
            // person's own (§6). `INSERT OR IGNORE` finds the matching partial unique
            // either way, so a bulk apply cannot duplicate what is already there.
            `INSERT OR IGNORE INTO
                "MediaTag" ("id", "mediaId", "tagId", "userId", "createdById", "source",
                            "batchId")
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );

        let assigned = 0;

        for (const { mediaId, tagId } of input.assignments) {
            assigned += insert.run(
                randomUUID(),
                mediaId,
                tagId,
                input.scope,
                // Who acted, on every row, whichever system it landed in. A public bulk
                // apply is the one place ten thousand rows can appear at once, and
                // reviewing it needs a name attached to them.
                input.userId,
                input.source ?? "user",
                batchId
            ).changes;
        }

        return { batchId, assigned };
    })();

export interface ApplyClipBatchInput {
    /** Who did it, and whose clips these are -- only a clip's owner tags it. */
    userId: string;
    summary: string;
    clipIds: string[];
    tagIds: string[];
}

/**
 * Applies tags to many clips as one undoable operation (§14d "Tagging clips").
 *
 * The item batch's shape and the same `INSERT OR IGNORE` reasoning: a clip already carrying the
 * tag keeps its own row, which never joins the batch. No scope to name -- a clip's assignments are
 * always its owner's, and the caller has checked the pairing for every tag and clip.
 *
 * Never a public batch: `findById` and `listPublic` ask for a `MediaTag` row with no owner, and a
 * clip batch writes none, so an administrator can neither find nor withdraw it.
 */
export const applyToClips = (input: ApplyClipBatchInput): ApplyBatchResult =>
    db.transaction((): ApplyBatchResult => {
        const batchId = randomUUID();

        db.prepare(
            `INSERT INTO "TagBatch" ("id", "userId", "summary", "mediaCount", "clipCount")
             VALUES (?, ?, ?, 0, ?)`
        ).run(batchId, input.userId, input.summary, input.clipIds.length);

        const insert = db.prepare(
            `INSERT OR IGNORE INTO "ClipTag" ("id", "clipId", "tagId", "batchId")
             VALUES (?, ?, ?, ?)`
        );

        let assigned = 0;

        for (const clipId of input.clipIds) {
            for (const tagId of input.tagIds) {
                assigned += insert.run(randomUUID(), clipId, tagId, batchId).changes;
            }
        }

        return { batchId, assigned };
    })();

/**
 * One batch, if this caller is allowed to reach it.
 *
 * `asAdmin` widens it to anybody's **public** batch, and that is the whole of the widening: a
 * private batch stays its owner's alone, administrators included, exactly as a private tag
 * does (§6).
 *
 * It exists because a public bulk apply can write `BULK_SELECTION_LIMIT` assignments in one
 * gesture. While a non-admin's batch was necessarily private, an owner-only undo was
 * sufficient; once anyone can publish ten thousand rows, an administrator who cannot withdraw
 * them is the one accident with no remedy.
 */
export const findById = (id: string, userId: string, asAdmin = false): TagBatchRow | undefined =>
    db
        .prepare(
            `SELECT b.* FROM "TagBatch" b
              WHERE b."id" = ?
                AND (b."userId" = ?
                     OR (? = 1 AND EXISTS (SELECT 1 FROM "MediaTag" mt
                                            WHERE mt."batchId" = b."id"
                                              AND mt."userId" IS NULL)))`
        )
        .get(id, userId, asAdmin ? 1 : 0) as TagBatchRow | undefined;

/**
 * Recent **public** batches from anybody, newest first — the administrator's list (§6).
 *
 * `findById` has let an administrator withdraw somebody else's public batch since the two
 * tagging systems split, and nothing has let them *find* one: a capability reachable only by
 * guessing an id is not a capability. A batch is public when it wrote any assignment with no
 * owner, which is the same test `findById` applies.
 *
 * Private batches are absent whoever is asking. Withdrawing one is its owner's alone, and a
 * summary naming what somebody tagged privately is itself the disclosure.
 */
export const listPublic = (limit: number): TagBatchRow[] =>
    db
        .prepare(
            `SELECT b.* FROM "TagBatch" b
              WHERE EXISTS (SELECT 1 FROM "MediaTag" mt
                             WHERE mt."batchId" = b."id" AND mt."userId" IS NULL)
              ORDER BY b."createdAt" DESC
              LIMIT ?`
        )
        .all(limit) as TagBatchRow[];

/** Recent batches, newest first — the list an undo is chosen from. */
export const listForUser = (userId: string, limit: number): TagBatchRow[] =>
    db
        .prepare(
            `SELECT * FROM "TagBatch"
              WHERE "userId" = ?
              ORDER BY "createdAt" DESC
              LIMIT ?`
        )
        .all(userId, limit) as TagBatchRow[];

/** The items a batch touched, needed to reindex them after it is withdrawn. */
export const affectedMediaIds = (batchId: string): string[] =>
    (
        db
            .prepare(`SELECT DISTINCT "mediaId" FROM "MediaTag" WHERE "batchId" = ?`)
            .all(batchId) as { mediaId: string }[]
    ).map((row) => row.mediaId);

/**
 * The tags a batch put on items, read before it is withdrawn: the OCR match counts it moves are
 * the pairs of these tags only (§5d "Counts").
 */
export const affectedTagIds = (batchId: string): string[] =>
    db
        .prepare(`SELECT DISTINCT "tagId" FROM "MediaTag" WHERE "batchId" = ?`)
        .pluck()
        .all(batchId) as string[];

/**
 * Withdraws a batch: deletes exactly the rows it created and records that it was undone.
 *
 * The batch row survives the undo. After the assignments are gone there is nothing left to
 * describe what happened, and "you tagged four thousand items and then changed your mind" is
 * what a person needs to see before trusting the feature a second time.
 */
export const undo = (batchId: string): number =>
    db.transaction((): number => {
        const tagIds = (
            db
                .prepare(`DELETE FROM "MediaTag" WHERE "batchId" = ? RETURNING "tagId"`)
                .all(batchId) as { tagId: string }[]
        )
            .concat(
                db
                    .prepare(`DELETE FROM "ClipTag" WHERE "batchId" = ? RETURNING "tagId"`)
                    .all(batchId) as { tagId: string }[]
            )
            .map((row) => row.tagId);
        const removed = tagIds.length;

        // A batch that coined a name takes it back with it when nothing else has used it since.
        pruneUnused([...new Set(tagIds)]);

        db.prepare(`UPDATE "TagBatch" SET "undoneAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(
            batchId
        );

        return removed;
    })();
