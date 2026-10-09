import { randomUUID } from "node:crypto";

import { findStage } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Queueing work from the web process.
 *
 * The worker has its own richer queue helpers; this is the small door the request side needs,
 * for jobs that take no arguments. Kept in a repo rather than written inline in a service so
 * the SQL lives where every other statement does.
 */

/**
 * Enqueues a job of this kind unless one is already outstanding.
 *
 * The queue's partial unique index covers (kind, mediaId, fileId), and for an argument-less
 * job those are all null — so without this check a library forgotten three times would queue
 * three identical sweeps, and with it the second and third are correctly no-ops.
 *
 * `delaySeconds` holds the job back that long, which turns the check into a debounce: every
 * request in the window lands on the one job already waiting, so a burst of them costs one run.
 */
export const enqueueKind = (kind: string, priority = 100, delaySeconds = 0): void => {
    db.prepare(
        `INSERT INTO "Job" ("id", "kind", "priority", "availableAt", "updatedAt")
         SELECT ?, ?, ?, datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'), CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
              SELECT 1 FROM "Job"
               WHERE "kind" = ? AND "state" IN ('pending', 'claimed')
          )`
    ).run(randomUUID(), kind, priority, delaySeconds, kind);
};

/**
 * Queues a scan of one library, ahead of ordinary work.
 *
 * Priority 5 matches the admin page's "Scan now": somebody is waiting for the answer, and
 * after a repoint the library's items are hidden until this runs.
 */
export const enqueueRootScan = (rootId: string): void => {
    db.prepare(
        `INSERT INTO "Job" ("id", "kind", "payloadJson", "priority", "updatedAt")
         VALUES (?, 'scan', ?, 5, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`
    ).run(randomUUID(), JSON.stringify({ rootId }));
};

/**
 * Cancels pending work against a library's files.
 *
 * Jobs resolve their file's path when they run, not when they are queued, so a probe or a
 * hash queued before a repoint would open whatever now sits at that relative path and write
 * its metadata — its duration, its codec, its perceptual hash — onto the item that used to
 * be there. A wrong hash is the worst of those, because duplicate detection then spreads it.
 *
 * Claimed jobs are left alone: they are already running, and the scan that follows a repoint
 * re-queues whatever it finds changed anyway.
 */
export const cancelPendingForRoot = (rootId: string): number =>
    db
        .prepare(
            `UPDATE "Job"
                SET "state" = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "state" = 'pending'
                AND "fileId" IN (SELECT "id" FROM "MediaFile" WHERE "rootId" = ?)`
        )
        .run(rootId).changes;

/**
 * Cancels the rendition for one item, whether it has started or not (§8, §18.7).
 *
 * `claimed` is included, which is the whole point: a transcode is the one job long enough to
 * be worth stopping, and the worker learns about this from the state of the row rather than
 * from a message — its heartbeat is already an `UPDATE ... WHERE state = 'claimed'`, so a
 * cancelled job's next beat matches nothing and the ffmpeg child is killed within a tick.
 *
 * Nothing is deleted here. Removing the partial output belongs to the process holding the
 * file open, and doing it from a request handler would race the encoder still writing to it.
 */
export const cancelTranscode = (mediaId: string): number =>
    db
        .prepare(
            `UPDATE "Job"
                SET "state" = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "kind" = 'transcode' AND "mediaId" = ?
                AND "state" IN ('pending', 'claimed')`
        )
        .run(mediaId).changes;

/**
 * Queue a rendition for one item, ahead of the background backlog.
 *
 * The one place the request side asks for a transcode. It exists for the item whose rendition
 * retention reclaimed (§8): the automatic sweep deliberately leaves those alone, so the only
 * thing that can bring one back is somebody opening the item — which is the moment this runs.
 *
 * Priority 50 rather than the backfill's 200. Somebody is waiting for this one and watching a
 * progress bar, whereas the backlog is work nobody has asked for yet.
 *
 * Idempotent through the queue's partial unique index on live jobs, which matters because a
 * viewer refreshing a page that will not play yet is the expected behaviour rather than an
 * edge case.
 */
export const enqueueTranscode = (mediaId: string): void => {
    /**
     * The file is looked up here rather than passed in.
     *
     * The detail row the caller holds does not carry one, and the job needs the *original*
     * rather than whichever file happens to be linked — a variant is itself a file. Selecting
     * it in the statement keeps that rule in the one place that already knows it, and yields
     * no row at all for an item whose original has been trashed, which correctly queues
     * nothing.
     */
    db.prepare(
        `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "priority", "mediaAddedAt",
                            "updatedAt")
         SELECT ?, 'transcode', m."id", fl."fileId", 50, m."addedAt", CURRENT_TIMESTAMP
           FROM "Media" m
           JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
           JOIN "MediaFile" f ON f."id" = fl."fileId" AND f."state" = 'active'
          WHERE m."id" = ?
          LIMIT 1
         ON CONFLICT DO NOTHING`
    ).run(randomUUID(), mediaId);
};

/**
 * Stop every rendition in flight or waiting, for the teardown that follows switching
 * transcoding off (§8).
 *
 * Cancelled rather than deleted, for the same reason the single-item cancel is: the runner
 * notices its row no longer matches and aborts its ffmpeg child, which is what actually stops
 * the work. A deleted row would leave the encode running with nothing to report to.
 */
export const cancelAllTranscodes = (): number =>
    db
        .prepare(
            `UPDATE "Job"
                SET "state" = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "kind" = 'transcode' AND "state" IN ('pending', 'claimed')`
        )
        .run().changes;

export interface LiveJobRow {
    kind: string;
    state: "pending" | "claimed";
}

/**
 * What is waiting or running for one item, by kind (§7b).
 *
 * The other half of the ledger. `MediaStage` records outcomes and nothing else, so a stage
 * somebody has just asked for read exactly as it did before they asked -- "on request", with
 * the button live again -- and the only way to learn the work had happened was to reload.
 *
 * Phrased to match `idx_Job_pending_unique` term for term: the kind list is its leading
 * column, the `COALESCE` is its expression, and the state test is its partial `WHERE`, so this
 * is a handful of index probes rather than a scan of a queue that can hold a whole backfill.
 */
export const liveForMedia = (mediaId: string, kinds: string[]): LiveJobRow[] =>
    kinds.length === 0
        ? []
        : (db
              .prepare(
                  `SELECT "kind", "state" FROM "Job"
                    WHERE "kind" IN (${kinds.map(() => "?").join(", ")})
                      AND COALESCE("mediaId", '') = ?
                      AND "state" IN ('pending', 'claimed')`
              )
              .all(...kinds, mediaId) as LiveJobRow[]);

const probe = findStage("probe");

/**
 * Not on an item the probe has settled as unreadable (§10g).
 *
 * Such a file fails every stage after the probe too, so it stood here three times over -- probe,
 * cover, sprite -- each with a Retry that could only fail again. It is Review › Unreadable's to
 * list, where the decision on offer is the right one: trash it. The Activity tab says how many
 * there are and links there instead.
 *
 * "Settled" is that list's own rule (`stageRepo.listSettledFailures`): the probe at its current
 * version, failed, out of attempts. One primary-key lookup per failure; library-wide work has no
 * item, compares null, and is kept.
 */
const ON_A_READABLE_ITEM = `NOT EXISTS (
        SELECT 1 FROM "MediaStage" "probe"
         WHERE "probe"."mediaId" = j."mediaId" AND "probe"."stage" = 'probe'
           AND "probe"."state" = 'failed'
           AND "probe"."attempts" >= ${probe?.maxAttempts ?? Number.MAX_SAFE_INTEGER}
           AND "probe"."version" >= ${probe?.version ?? Number.MAX_SAFE_INTEGER}
    )`;

/**
 * A failure that still stands: no job of the same kind for the same item was queued after it.
 *
 * Failed rows are kept after a later attempt succeeds (`prunableJobIds` explains why), so
 * counting every one reports problems fixed long ago. "Queued after" is the rowid, which grows
 * with every insert, rather than `createdAt`, whose one-second resolution ties a retry with
 * the failure it retries. `IS` compares the nulls of library-wide work.
 *
 * Both halves are indexed (�20): `idx_Job_failed` finds the failures without reading the queue,
 * and `idx_Job_mediaId_kind` answers the probe from one item's rows of one kind. Pruning keeps
 * the table small but not small enough -- on a saturated disk the scan this replaced read six
 * hundred pages to find seventy failures.
 */
const STANDING_FAILURE = `j."state" = 'failed'
    AND NOT EXISTS (
        SELECT 1 FROM "Job" "later"
         WHERE "later"."kind" = j."kind"
           AND "later"."mediaId" IS j."mediaId"
           AND "later"."rowid" > j."rowid"
    )
    AND ${ON_A_READABLE_ITEM}`;

export interface FailedJobRow {
    id: string;
    cursor: number;
    kind: string;
    mediaId: string | null;
    fileId: string | null;
    title: string | null;
    relPath: string | null;
    lastError: string | null;
    attempts: number;
    failedAt: string;
}

const FAILED_COLUMNS = `j."id", j."rowid" AS "cursor", j."kind", j."mediaId", j."fileId",
        m."title", f."relPath", j."lastError", j."attempts",
        COALESCE(j."finishedAt", j."updatedAt") AS "failedAt"`;

/**
 * Standing failures, newest first, a page at a time (§13c).
 *
 * Paged by rowid rather than offset: retrying takes rows off this list while somebody pages
 * through it, and an offset would then skip the ones that moved up.
 *
 * `+j."rowid"` stops the planner satisfying the order by walking the whole table backwards in
 * the hope of meeting fifty failures early -- it cannot know there are only tens of them. Sorting
 * the failures it finds through `idx_Job_failed` touches a fraction of the pages.
 */
export const listFailed = (options: {
    kind?: string;
    after?: number;
    limit: number;
}): FailedJobRow[] =>
    db
        .prepare(
            `SELECT ${FAILED_COLUMNS}
               FROM "Job" j
               LEFT JOIN "Media" m ON m."id" = j."mediaId"
               LEFT JOIN "MediaFile" f ON f."id" = j."fileId"
              WHERE ${STANDING_FAILURE}
                AND (@kind IS NULL OR j."kind" = @kind)
                AND (@after IS NULL OR j."rowid" < @after)
              ORDER BY +j."rowid" DESC
              LIMIT @limit`
        )
        .all({
            kind: options.kind ?? null,
            after: options.after ?? null,
            limit: options.limit,
        }) as FailedJobRow[];

/** These failures, where they still stand -- what a retry acts on. */
export const findFailed = (ids: string[]): FailedJobRow[] =>
    ids.length === 0
        ? []
        : (db
              .prepare(
                  `SELECT ${FAILED_COLUMNS}
                     FROM "Job" j
                     LEFT JOIN "Media" m ON m."id" = j."mediaId"
                     LEFT JOIN "MediaFile" f ON f."id" = j."fileId"
                    WHERE ${STANDING_FAILURE}
                      AND j."id" IN (${ids.map(() => "?").join(", ")})`
              )
              .all(...ids) as FailedJobRow[]);

/** Standing failures per kind, most first. */
export const failedKinds = (): { kind: string; count: number }[] =>
    db
        .prepare(
            `SELECT j."kind", count(*) AS "count"
               FROM "Job" j
              WHERE ${STANDING_FAILURE}
              GROUP BY j."kind"
              ORDER BY "count" DESC, j."kind"`
        )
        .all() as { kind: string; count: number }[];

/**
 * Whether anything is queued or running: one descent of the index that holds only live jobs.
 *
 * The processing view's check that an idle answer it cached is still idle (§13c) -- asked on
 * every request that would reuse it, so it must cost a page, not a count.
 */
export const anyLive = (): boolean =>
    !!db
        .prepare(
            `SELECT 1 FROM "Job" INDEXED BY "idx_Job_pending_unique"
              WHERE "state" IN ('pending', 'claimed') LIMIT 1`
        )
        .get();

export interface QueueKindRow {
    kind: string;
    pending: number;
    claimed: number;
}

export interface QueueSummary {
    pending: number;
    claimed: number;
    failed: number;
    workerAlive: boolean;
    byKind: QueueKindRow[];
}

/**
 * What the queue is holding, for the processing view (§13c).
 *
 * `workerAlive` is the part worth having. A progress bar that has not moved in ten minutes
 * looks the same whether the worker is grinding through a 4K transcode or died in the night,
 * and those call for opposite responses. A claim is abandoned after `STALE_CLAIM_MS` without
 * a beat and the runner beats every fifteen seconds, so a claimed job whose heartbeat is
 * inside the last minute is proof something is running. No claims at all is not evidence
 * either way -- an idle worker and a dead one both hold nothing -- so it reports false and
 * the UI says "idle" rather than accusing anything.
 */
export const queueSummary = (): QueueSummary => {
    // Live jobs per kind from the partial index that holds only live jobs, and the claimed ones
    // -- a handful, the worker's concurrency -- from the heartbeat index, which holds only those.
    // Splitting pending from claimed in one statement needs `state`, which no small index
    // carries: it walked `idx_Job_kind_state`, finished jobs included (~150 pages on the
    // replica, against ~65 this way, on a view polled every two seconds while work runs).
    const live = db
        .prepare(
            `SELECT "kind", count(*) AS "count"
               FROM "Job" INDEXED BY "idx_Job_pending_unique"
              WHERE "state" IN ('pending', 'claimed')
              GROUP BY "kind"`
        )
        .all() as { kind: string; count: number }[];
    const claimedByKind = new Map(
        (
            db
                .prepare(
                    `SELECT "kind", count(*) AS "count"
                       FROM "Job" INDEXED BY "idx_Job_heartbeat"
                      WHERE "state" = 'claimed'
                      GROUP BY "kind"`
                )
                .all() as { kind: string; count: number }[]
        ).map((row) => [row.kind, row.count])
    );
    const byKind: QueueKindRow[] = live
        .map((row) => {
            const claimed = claimedByKind.get(row.kind) ?? 0;

            return { kind: row.kind, pending: row.count - claimed, claimed };
        })
        .sort(
            (left, right) =>
                right.pending + right.claimed - (left.pending + left.claimed) ||
                (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
        );

    // Standing failures only, as the failed-jobs list counts them: a failure retried since --
    // successfully or not -- is the later row's to report.
    const failed = db
        .prepare(`SELECT count(*) AS "count" FROM "Job" j WHERE ${STANDING_FAILURE}`)
        .get() as { count: number };

    const beating = db
        .prepare(
            `SELECT 1 FROM "Job"
              WHERE "state" = 'claimed'
                AND "heartbeatAt" IS NOT NULL
                AND "heartbeatAt" > datetime('now', '-60 seconds')
              LIMIT 1`
        )
        .get();

    return {
        pending: byKind.reduce((sum, row) => sum + row.pending, 0),
        claimed: byKind.reduce((sum, row) => sum + row.claimed, 0),
        failed: failed.count,
        workerAlive: !!beating,
        byKind,
    };
};

/** What makes a job deletable; `?` is the age, as a `datetime` modifier. */
const PRUNABLE = `"done"."state" = 'done'
    AND "done"."updatedAt" < datetime('now', ?)
    AND NOT EXISTS (
        SELECT 1 FROM "Job" AS "settled"
         WHERE "settled"."kind" = "done"."kind"
           AND "settled"."mediaId" IS "done"."mediaId"
           AND "settled"."state" IN ('failed', 'cancelled')
    )`;

/**
 * Deletes finished work nobody reads any more (§20).
 *
 * The queue had no retention at all: `ChangeLog` was pruned from the first version and `Job`
 * never, so a succeeded row stayed for ever. Measured on the real library that is **97,717 rows**
 * for a 14,181-item catalogue — a large share of a 113 MiB database, and the table every insert,
 * claim and completion maintains four indexes over. Nothing reads a `done` row: the record of
 * "this has been attempted" is `MediaStage`, which is why the sweep can take these at all.
 *
 * **`failed` and `cancelled` rows are kept, and that is not caution but correctness.**
 * `settledMediaIds` reads exactly those two states to decide what must *not* be queued again —
 * an unencodable file, or a job somebody stopped. Delete them and the five-minute backfill
 * rediscovers the work within the hour, for ever. They are also the only trace of why something
 * never appeared, which is the question that gets asked.
 *
 * A `done` row is skipped while a `failed` or `cancelled` row exists for the same
 * `(kind, mediaId)`, because `settledMediaIds` asks whether anything *later* exists for that pair:
 * removing a later success would turn a retried item back into a settled failure and quietly stop
 * work that is currently allowed. `IS` rather than `=` compares the nulls of library-wide jobs.
 *
 * **Found with a read, deleted by id.** One `DELETE … WHERE id IN (SELECT …)` holds the write lock
 * for the whole search as well as the delete, and on the NAS a search through a cold queue took
 * most of the 18.7 s that a 531-row prune held the lock for — long enough for a web write to give
 * up with a 503 (§20). So `prunableJobIds` finds the candidates with no lock at all and
 * `deleteFinishedJobs` takes a small batch of them at a time. The delete repeats every condition
 * rather than trusting the read: a row that was retried, or gained a failure beside it, in between
 * is left alone.
 */
export const prunableJobIds = (olderThanMinutes: number, limit: number): string[] =>
    db
        .prepare(
            `SELECT "done"."id" FROM "Job" AS "done"
              WHERE ${PRUNABLE}
              LIMIT ?`
        )
        .pluck()
        .all(`-${olderThanMinutes} minutes`, limit) as string[];

/** Deletes the given finished jobs that still qualify; see `prunableJobIds`. */
export const deleteFinishedJobs = (ids: string[], olderThanMinutes: number): number =>
    ids.length === 0
        ? 0
        : db
              .prepare(
                  `DELETE FROM "Job"
                    WHERE "id" IN (
                          SELECT "done"."id" FROM json_each(?) AS "wanted"
                            JOIN "Job" AS "done" ON "done"."id" = "wanted"."value"
                           WHERE ${PRUNABLE}
                    )`
              )
              .run(JSON.stringify(ids), `-${olderThanMinutes} minutes`).changes;

/**
 * Hand running background jobs back to the queue, for a pause (§7c "Pausing").
 *
 * Pausing is meant to take effect now, not after the slowest job in flight finishes — an OCR
 * pass started a moment before the pause would otherwise store text read with the settings the
 * administrator paused in order to change. The worker learns the way a cancelled transcode
 * does: its next heartbeat, an `UPDATE ... WHERE state = 'claimed'`, matches nothing, and the
 * handler stops as a lost claim within a tick.
 *
 * Back to `pending` rather than `cancelled`, so resuming picks them up again; and the attempt
 * the claim counted is refunded, because being paused is not a failure and a job allowed one
 * attempt must not be spent by it.
 *
 * Requested work and the bin's moves are left running, as the pause leaves them claimable: the
 * first is somebody waiting, the second a deletion that should not stop half-done.
 */
export const releaseBackgroundClaims = (): number =>
    db
        .prepare(
            `UPDATE "Job"
                SET "state" = 'pending',
                    "claimedBy" = NULL,
                    "startedAt" = NULL,
                    "heartbeatAt" = NULL,
                    "progress" = NULL,
                    "attempts" = MAX(0, "attempts" - 1),
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "state" = 'claimed'
                AND "requestedByUserId" IS NULL
                AND "kind" NOT IN ('trash', 'restore', 'purge')`
        )
        .run().changes;
