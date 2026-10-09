import { randomUUID } from "node:crypto";

import type { Db } from "@private-stock/db";

/**
 * The job queue (§18.7).
 *
 * The two properties that make this a queue rather than a to-do list:
 *
 *   1. **Claiming is atomic.** One `UPDATE ... WHERE state = 'pending'` picks the row and
 *      marks it in the same statement, so two workers can never take the same job.
 *   2. **Crashes are recoverable.** A claimed job whose heartbeat has gone stale returns to
 *      pending. A killed container, an OOM, or a hung ffmpeg all resolve themselves.
 */

/** A claim is considered abandoned after this long without a heartbeat. */
export const STALE_CLAIM_MS = 60_000;

export interface JobRow {
    id: string;
    kind: string;
    mediaId: string | null;
    fileId: string | null;
    payloadJson: string | null;
    attempts: number;
    maxAttempts: number;
    /** Set when a person asked for this job rather than a sweep scheduling it (§7c). */
    requestedByUserId: string | null;
}

export interface EnqueueOptions {
    kind: string;
    mediaId?: string | null;
    fileId?: string | null;
    payload?: unknown;
    priority?: number;
    maxAttempts?: number;
    availableAt?: Date;
    /** Who asked for this, if anyone did. Exempts the job from throttling (§7c). */
    requestedByUserId?: string | null;
}

/**
 * Add a job, ignoring it if the same work is already queued or running.
 *
 * The partial unique index on `(kind, mediaId, fileId) WHERE state IN ('pending','claimed')`
 * is what makes `ON CONFLICT DO NOTHING` correct here: re-running a scan that finds the same
 * unprobed file must not queue a second probe, but must be free to queue one again once the
 * first has finished.
 *
 * Returns whether a row went in. Most callers do not care; one that rides something on the
 * job's payload does, because a conflict keeps the job already there and drops the payload.
 */
/**
 * A date in the format every comparison in this schema uses.
 *
 * `toISOString()` is the obvious thing and is silently wrong here. SQLite has no date type:
 * `CURRENT_TIMESTAMP` is the **text** "YYYY-MM-DD HH:MM:SS", and these columns are compared as
 * text. An ISO string differs in exactly the character that decides the comparison -- "T"
 * (0x54) against a space (0x20) -- so "...-17T09:00:00.000Z" sorts *after* "...-17 09:00:00"
 * for the same instant, and after every later one that day too.
 *
 * A job deferred with an ISO string therefore satisfies `availableAt <= CURRENT_TIMESTAMP`
 * essentially never: it sits pending, is skipped by every claim, and blocks its own kind
 * through the unique index for ever. Nothing passed `availableAt` until the duplicate pass
 * began deferring itself, so the bug had never had an opportunity to happen.
 *
 * Both sides are UTC, so slicing is the whole conversion.
 */
const asSqliteTimestamp = (date: Date): string => date.toISOString().slice(0, 19).replace("T", " ");

export const enqueue = (db: Db, options: EnqueueOptions): boolean =>
    db
        .prepare(
            `INSERT INTO "Job"
            ("id", "kind", "mediaId", "fileId", "payloadJson", "priority", "maxAttempts",
             "availableAt", "requestedByUserId", "mediaAddedAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?,
                 -- Derived here rather than passed in, so no caller can forget it and no
                 -- caller needs the row in hand (§7d). Null for library-wide work.
                 (SELECT "addedAt" FROM "Media" WHERE "id" = ?),
                 CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`
        )
        .run(
            randomUUID(),
            options.kind,
            options.mediaId ?? null,
            options.fileId ?? null,
            options.payload === undefined ? null : JSON.stringify(options.payload),
            options.priority ?? 100,
            options.maxAttempts ?? 3,
            options.availableAt ? asSqliteTimestamp(options.availableAt) : null,
            options.requestedByUserId ?? null,
            options.mediaId ?? null
        ).changes > 0;

/**
 * Claim the next available job.
 *
 * Kinds are passed in rather than claiming anything, because concurrency is per kind: probe
 * and phash can run several at once, transcode runs one or the NAS stops serving pages.
 *
 * `requestedKinds` is the throttle's exemption (§7c): kinds that have run out of slots under
 * the throttled limit but still have room under the full one. Work somebody asked for may
 * take those slots; the sweep's own work may not. It is expressed here rather than by
 * claiming and then putting the job back, because a claim that is immediately released has
 * already bumped `attempts` and already raced every other worker for the row.
 */
export const claimNext = (
    db: Db,
    kinds: string[],
    workerId: string,
    requestedKinds: string[] = []
): JobRow | null => {
    if (kinds.length === 0 && requestedKinds.length === 0) {
        return null;
    }

    const list = (names: string[]): string => names.map(() => "?").join(", ");

    /**
     * Built rather than fixed, so the unthrottled path is byte for byte the statement it was
     * before this existed -- and `db.prepare` caches by SQL text, so the two shapes are
     * compiled once each rather than on every claim.
     */
    const clauses = [
        ...(kinds.length > 0 ? [`"kind" IN (${list(kinds)})`] : []),
        ...(requestedKinds.length > 0
            ? [`("kind" IN (${list(requestedKinds)}) AND "requestedByUserId" IS NOT NULL)`]
            : []),
    ];

    const row = db
        .prepare(
            `UPDATE "Job"
                SET "state" = 'claimed',
                    "claimedBy" = ?,
                    "startedAt" = CURRENT_TIMESTAMP,
                    "heartbeatAt" = CURRENT_TIMESTAMP,
                    "attempts" = "attempts" + 1,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = (
                    SELECT "id" FROM "Job"
                     WHERE "state" = 'pending'
                       AND (${clauses.join(" OR ")})
                       AND "availableAt" <= CURRENT_TIMESTAMP
                     /*
                      * The order the library is in (§7d).
                      *
                      * Priority first, because that is a statement about what kind of work
                      * matters -- a probe before a sprite, whatever they belong to. Within a
                      * band the newest item wins, so processing starts at the end of the
                      * library somebody is actually looking at. This used to fall through to
                      * createdAt, which is walk order: the exact opposite of the default
                      * view, so a fresh import filled in from the far end and the first page
                      * stayed blank until nearly everything else was done.
                      *
                      * A null mediaAddedAt sorts last under DESC, which is what library-wide
                      * work should do: a duplicate pass has no business preceding the items
                      * it is about to compare.
                      *
                      * createdAt remains the final tiebreak. A bulk import gives hundreds of
                      * items the same second, and without it their order would be whatever
                      * the index happened to return.
                      */
                     ORDER BY "priority" ASC, "mediaAddedAt" DESC, "createdAt" ASC
                     LIMIT 1
              )
          RETURNING "id", "kind", "mediaId", "fileId", "payloadJson", "attempts", "maxAttempts",
                    "requestedByUserId"`
        )
        .get(workerId, ...kinds, ...requestedKinds) as JobRow | undefined;

    return row ?? null;
};

/**
 * Say the job is still alive, and find out whether it still belongs to us.
 *
 * Returns false when the update matched nothing, which means the row left `claimed` while the
 * handler was working: somebody cancelled it, or the reclaim sweep decided this worker was
 * gone and handed the work back. Either way the caller has lost the claim and should stop —
 * so the statement that was already being written every few seconds doubles as the poll, and
 * cancellation costs no extra query.
 */
export const heartbeat = (db: Db, jobId: string, progress?: number): boolean =>
    db
        .prepare(
            `UPDATE "Job"
                SET "heartbeatAt" = CURRENT_TIMESTAMP,
                    "progress" = COALESCE(?, "progress"),
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ? AND "state" = 'claimed'`
        )
        .run(progress ?? null, jobId).changes > 0;

/**
 * How often a running job says it is still alive.
 *
 * A quarter of `STALE_CLAIM_MS`, so three ticks have to be missed before the reclaim sweep
 * decides the worker is gone. One missed tick — a synchronous batch write, a slow share —
 * must not be enough, because reclaiming a job that is still running means two copies of it.
 */
export const HEARTBEAT_INTERVAL_MS = STALE_CLAIM_MS / 4;

export interface JobLifetime {
    /** Aborted when the claim is lost, whether to a cancellation or to the reclaim sweep. */
    signal: AbortSignal;
    /** Call when the handler returns, however it returned. */
    stop: () => void;
}

/**
 * Hold a claim for as long as the handler runs, and say when it is no longer held.
 *
 * Without the ticker only `transcode` heartbeats, because only `transcode` has progress to
 * report — so every other kind that runs past `STALE_CLAIM_MS` has its row flipped back to
 * pending while it is still working. For a kind with a concurrency above one that is not
 * theoretical: the same job is claimed and run a second time, and whichever finishes first
 * marks it done.
 *
 * The signal is the other half. Cancelling a job that has not started is one `UPDATE`, but
 * one already running needs the process doing the work to find out, and this is where it
 * does — so cancellation is a state the web app writes, not a message it has to deliver to a
 * process it cannot reach (§18.7).
 *
 * The ticker is `unref`'d so a handler that never returns cannot by itself hold the process
 * open at shutdown. It is a **liveness** signal and nothing more: the worker is single
 * threaded, so a handler that blocks the event loop — a long synchronous transaction —
 * stops the ticker too, and that job is correctly treated as stuck.
 */
export const startHeartbeat = (db: Db, jobId: string): JobLifetime => {
    const controller = new AbortController();

    const timer = setInterval(() => {
        if (!heartbeat(db, jobId)) {
            clearInterval(timer);
            // "cancelled" rather than an Error: it is the reason, and a handler that surfaces
            // it in a message should not make this read like a failure.
            controller.abort("cancelled");
        }
    }, HEARTBEAT_INTERVAL_MS);

    timer.unref?.();

    return {
        signal: controller.signal,
        stop: () => clearInterval(timer),
    };
};

/** The jobs whose subject is *meant* to be in the bin: they move its bytes (§10). */
const BIN_KINDS = new Set(["trash", "restore", "purge"]);

/**
 * Whether the item a job was for has left the library since it was queued.
 *
 * Deleted outright (an identical copy, §10e, is purged seconds after it is trashed), or in the
 * bin. Trashing deletes the item's queued work and cancels its running work, but a job can
 * still reach a handler afterwards -- enqueued in between by a scan or a stage that finished, or
 * claimed in the instant before the cancel landed -- and then fails on a file that is not there.
 * Counted as a failure it is retried with backoff, dead-lettered, and recorded against a stage
 * of an item that no longer exists.
 *
 * Read at the moment of asking rather than carried on the job, because the whole point is to
 * catch a change that happened after it was queued.
 */
export const subjectGone = (db: Db, job: JobRow): boolean => {
    if (BIN_KINDS.has(job.kind)) {
        return false;
    }

    if (job.mediaId) {
        const original = db
            .prepare(
                `SELECT f."state" FROM "Media" m
                   LEFT JOIN "MediaFileLink" fl
                          ON fl."mediaId" = m."id" AND fl."role" = 'original'
                   LEFT JOIN "MediaFile" f ON f."id" = fl."fileId"
                  WHERE m."id" = ?`
            )
            .get(job.mediaId) as { state: string | null } | undefined;

        if (!original || original.state === "trashed") {
            return true;
        }
    }

    if (job.fileId) {
        const file = db
            .prepare(`SELECT "state" FROM "MediaFile" WHERE "id" = ?`)
            .get(job.fileId) as { state: string } | undefined;

        if (!file || file.state === "trashed") {
            return true;
        }
    }

    return false;
};

/**
 * Closes a claimed job whose item has gone (`subjectGone`), as cancelled rather than failed.
 *
 * Nothing went wrong with the work; there is simply nothing left to do it to. `cancelled` is
 * what trashing gives the item's other jobs, and what a restore forgets (§10).
 */
export const abandon = (db: Db, jobId: string): void => {
    db.prepare(
        `UPDATE "Job"
            SET "state" = 'cancelled',
                "finishedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" = 'claimed'`
    ).run(jobId);
};

export const complete = (db: Db, jobId: string): void => {
    db.prepare(
        `UPDATE "Job"
            SET "state" = 'done',
                "progress" = 1,
                "finishedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" = 'claimed'`
    ).run(jobId);
};

/**
 * Record a failure, scheduling a retry or dead-lettering.
 *
 * Exponential backoff, then a terminal `failed` state with the error preserved for the
 * admin job view. A corrupt file that ffmpeg cannot read must stop retrying — otherwise one
 * bad file occupies a worker slot forever.
 *
 * `permanent` dead-letters on the first failure, for errors that describe the file rather
 * than the attempt (`isUnreadableSource`). Counting attempts alone stopped the retrying
 * eventually, but only after spending every one of them on an answer already known.
 */
export const fail = (
    db: Db,
    job: JobRow,
    error: unknown,
    options: { permanent?: boolean } = {}
): void => {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = options.permanent === true || job.attempts >= job.maxAttempts;

    if (exhausted) {
        db.prepare(
            `UPDATE "Job"
                SET "state" = 'failed',
                    "lastError" = ?,
                    "finishedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ? AND "state" = 'claimed'`
        ).run(message.slice(0, 4000), job.id);

        return;
    }

    const backoffSeconds = Math.min(2 ** job.attempts * 30, 3600);

    db.prepare(
        `UPDATE "Job"
            SET "state" = 'pending',
                "claimedBy" = NULL,
                "startedAt" = NULL,
                "heartbeatAt" = NULL,
                "lastError" = ?,
                "availableAt" = datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'),
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" = 'claimed'`
    ).run(message.slice(0, 4000), backoffSeconds, job.id);
};

/**
 * Return abandoned claims to the queue.
 *
 * Run on startup and periodically. On startup it is what recovers the work in flight when
 * the container was last killed — Container Station restarts are not graceful.
 */
export const reclaimStaleJobs = (db: Db, staleMs: number = STALE_CLAIM_MS): number => {
    const result = db
        .prepare(
            `UPDATE "Job"
                SET "state" = 'pending',
                    "claimedBy" = NULL,
                    "startedAt" = NULL,
                    "heartbeatAt" = NULL,
                    "lastError" = COALESCE("lastError", 'Reclaimed after worker went away'),
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "state" = 'claimed'
                AND ("heartbeatAt" IS NULL
                     OR "heartbeatAt" < datetime(CURRENT_TIMESTAMP, '-' || ? || ' seconds'))`
        )
        .run(Math.round(staleMs / 1000));

    return result.changes;
};

/**
 * Items whose last job of this kind settled in a way the sweep must not undo.
 *
 * Two different decisions with one mechanism, because the sweep has to respect both:
 *
 *  - **Cancelled.** Someone pressed stop. The five-minute sweep queues whatever is still
 *    owed, and a cancelled transcode owes exactly as much as it did before — so the job would
 *    be back within five minutes, forever, and the button would look broken rather than
 *    obeyed.
 *  - **Failed.** The queue already retried it to exhaustion. Unlike a stage, a transcode
 *    records no `MediaStage` row (it is a job kind, not a registry stage), so `needsWork` has
 *    no opinion about it and nothing else remembers the failure. Without this, a file the
 *    encoder simply cannot accept is re-queued every five minutes and fails three times on
 *    every pass — permanently, and while looking like ordinary activity.
 *
 * A later job for the same item overrides either, which is what keeps an explicit "try this
 * one again" working: the sweep stays out of the way, a person is still obeyed.
 */
/**
 * How much of one kind is already waiting to be done.
 *
 * For the sweep's high-water mark (`backfill.ts`): the queue is a work list, not a plan, and there
 * is nothing to gain from a row that will sit unclaimed for a day. Claimed counts too, because a
 * transcode holds its row for minutes and a sweep that ignored them would queue a fresh batch
 * against work already under way.
 */
export const outstandingForKind = (db: Db, kind: string): number =>
    (
        db
            .prepare(
                `SELECT count(*) AS n FROM "Job"
                  WHERE "kind" = ? AND "state" IN ('pending', 'claimed')`
            )
            .get(kind) as { n: number }
    ).n;

export const settledMediaIds = (db: Db, kind: string): Set<string> => {
    const rows = db
        .prepare(
            `SELECT "mediaId" FROM "Job" AS "settled"
              WHERE "kind" = ? AND "state" IN ('cancelled', 'failed') AND "mediaId" IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM "Job" AS "later"
                     WHERE "later"."kind" = "settled"."kind"
                       AND "later"."mediaId" = "settled"."mediaId"
                       AND "later"."createdAt" > "settled"."createdAt"
                )`
        )
        .all(kind) as { mediaId: string }[];

    return new Set(rows.map((row) => row.mediaId));
};
