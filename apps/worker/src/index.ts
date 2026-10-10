import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";

import {
    SETTING_KEYS,
    WEBSAFE_PROFILE,
    assertSafeRelativePath,
    assessPlayback,
    stagePolicySchema,
    findStage,
    isUnreadableSource,
    prerequisiteOf,
    prerequisiteSettled,
    type StageOutcome,
    type StageState,
} from "@private-stock/core";
import { dataPaths, ensureDataDirs, loadConfig } from "@private-stock/core/server";
import {
    changeLogRepo,
    checkpointWal,
    db,
    jobRepo,
    mediaRepo,
    stageRepo,
    refreshTokenRepo,
    mediaRootRepo,
    scanRepo,
    settingRepo,
    trashRepo,
    variantRepo,
} from "@private-stock/db";

import {
    backfillStages,
    COVER_BACKFILL_BATCH,
    stageChangeMarks,
    type IdleStages,
} from "./backfill.js";
import { runCover } from "./jobs/cover.js";
import { runPreview } from "./jobs/preview.js";
import { runProbe } from "./jobs/probe.js";
import { runOcr } from "./jobs/ocr.js";
import { runMentionMatch } from "./jobs/mentionMatch.js";
import { runOcrMatch } from "./jobs/ocrMatch.js";
import { runOcrTrial } from "./jobs/ocrTrial.js";
import { runOcrTune } from "./jobs/ocrTune.js";
import { runSprite } from "./jobs/sprite.js";
import { loadTranscodeSettings, runTranscodeJob, transcodingEnabled } from "./jobs/transcode.js";
import { runVariantPurge } from "./jobs/variantPurge.js";
import { runDupes } from "./jobs/dupes.js";
import { runEmbed } from "./jobs/embed.js";
import { runFaceAnchors } from "./jobs/faceAnchors.js";
import { runTagLookPictures } from "./jobs/tagLookPictures.js";
import { runTagPictures } from "./jobs/tagPictures.js";
import { runFaces } from "./jobs/faces.js";
import { withAffinity, modelKindsWaited } from "./embed/affinity.js";
import { heldFamily, stopModelChild } from "./embed/embedder.js";
import { runFileHash } from "./jobs/fileHash.js";
import { runPhash } from "./jobs/phash.js";
import { runScan } from "./jobs/scan.js";
import { runOrphanSweep } from "./jobs/orphans.js";
import { runPurge, runRestore, runTrash } from "./jobs/trash.js";
import { runIndex } from "./jobs/searchIndex.js";
import { resolveSource } from "./media/sourcePath.js";
import { COLLECT_INTERVAL_MS, collectGarbage } from "./memory.js";
import {
    abandon,
    settledMediaIds,
    claimNext,
    complete,
    enqueue,
    fail,
    reclaimStaleJobs,
    startHeartbeat,
    subjectGone,
    type JobRow,
} from "./queue.js";

import { startWatchers, type WatcherHandle } from "./scan/watcher.js";
import { watchSignature } from "./scan/watchSet.js";
import { STARTUP_GRACE_MS, firstRunAfter, inStartupGrace, scheduleDeferred } from "./startup.js";
import { claimableKinds, processingPaused, runWithPoliteness, throttleState } from "./throttle.js";

/**
 * The worker process.
 *
 * Deliberately not an HTTP server and deliberately not inside Next: ffmpeg jobs run for
 * minutes and saturate CPU, and must not share a process with request handling on a NAS
 * (§2). It coordinates with the web app purely through the `Job` table.
 */

const WORKER_ID = `${hostname()}:${process.pid}`;
const IDLE_POLL_MS = 2_000;
const RECLAIM_INTERVAL_MS = 30_000;
/**
 * How often the worker drains the WAL, so the web process never has to (`checkpointWal`, §4).
 * Short enough that an idle worker still keeps the WAL small; each pass is a no-op when the
 * worker's own commits have already checkpointed.
 */
const WAL_CHECKPOINT_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const COVER_BACKFILL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How often the derived tree is reconciled against the database (§13d).
 *
 * Daily, and once after the startup grace (`startup.ts`). The startup pass is the one that
 * matters: it is what notices a database that was reset, restored from a backup, or initialised
 * fresh beside a `/data` full of artifacts belonging to a database that no longer exists.
 * Nothing else would ever look -- the sweep used to be enqueued from exactly one place,
 * forgetting a library, so a reset left its litter behind permanently. Late by the grace and
 * its stagger, never skipped.
 *
 * Not hourly. It is a full walk of a directory holding several files per item, which on a
 * 200k library is a real cost to pay for a reconciliation that almost always finds nothing
 * (§17).
 */
const ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How often sources' and keywords' pictures are read again from their items' looks (§6 "A tag's
 * picture"). A typical look moves slowly, and each pass reads the whole representatives log.
 */
const LOOK_PICTURES_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How often the worker checks whether the set of libraries has changed.
 *
 * Watching used to be rebuilt on the periodic scan timer, which defaults to a day. A library
 * added or enabled from the admin page therefore went unwatched until the next sweep, and
 * files dropped into it did not appear until someone scanned by hand — the feature looked
 * broken in precisely the situation it exists for, the first one anybody tries.
 *
 * Half a minute, because this is one indexed read of a table with a handful of rows and
 * nothing happens unless the answer actually changed. A short poll rather than a signal
 * through the queue: the two processes share a database and nothing else (§2), so the
 * database is where "the libraries changed" has to be observed.
 */
const ROOT_WATCH_POLL_MS = 30_000;

/** How long a change stays in the feed. Long enough to cover a reconnect, not a session. */
const CHANGE_LOG_RETENTION_MINUTES = 60;

/**
 * How long a succeeded job stays before the sweep takes it.
 *
 * A day, which is not about anything reading it — nothing does — but about being able to look at
 * what the worker did while you were asleep, from the container log alongside it. The record that
 * a stage *has been attempted* is `MediaStage` and outlives this entirely.
 */
const JOB_RETENTION_MINUTES = 24 * 60;

/**
 * How many finished jobs one statement may delete, and how many statements one pass may run.
 *
 * A pass finds up to `JOB_PRUNE_PER_PASS` candidates with a read (no lock), then deletes them
 * `JOB_PRUNE_BATCH` at a time with a pause between, so the write lock is never held for more than
 * a few dozen rows' index maintenance and a waiting web write always gets a turn (§4, §20). It was
 * 2,000 rows a statement, with the candidate search inside the lock: 531 rows held it for 18.7 s on
 * the NAS and a rating save answered 503.
 *
 * The per-pass ceiling is what made the first pass useful rather than symbolic: the real library
 * arrived with **72,577** finished rows already recorded, and ten thousand an hour clears that
 * overnight. In the steady state a pass finds a few hundred.
 */
const JOB_PRUNE_PER_PASS = 10_000;
const JOB_PRUNE_BATCH = 25;
const JOB_PRUNE_PAUSE_MS = 100;

/** Prunes finished jobs in short write batches; see `JOB_PRUNE_BATCH`. */
const pruneFinishedJobs = async (): Promise<number> => {
    const ids = jobRepo.prunableJobIds(JOB_RETENTION_MINUTES, JOB_PRUNE_PER_PASS);
    let deleted = 0;

    for (let start = 0; start < ids.length; start += JOB_PRUNE_BATCH) {
        if (start > 0) {
            await new Promise((resolve) => setTimeout(resolve, JOB_PRUNE_PAUSE_MS));
        }

        deleted += jobRepo.deleteFinishedJobs(
            ids.slice(start, start + JOB_PRUNE_BATCH),
            JOB_RETENTION_MINUTES
        );
    }

    return deleted;
};

/**
 * The periodic full scan is a **safety net**, not the primary mechanism.
 *
 * Filesystem events do the real work and pick changes up within seconds (§7). This sweep
 * exists only for what events cannot see: writes to a remote share by another machine,
 * events dropped while the worker was down, and shares that come back online.
 *
 * Daily, because walking a large library is expensive and almost always finds nothing when
 * watching is working. An admin can set the interval to 0 to switch it off entirely — which
 * is the right choice for a library whose roots are all local and reliably watched, and the
 * wrong one for a mounted remote share.
 */
const DEFAULT_SCAN_INTERVAL_MINUTES = 24 * 60;

/**
 * A handler says how the attempt ended; returning nothing means it produced output.
 *
 * `"empty"` is the value that matters. A blank image has no perceptual hash and a five-second
 * clip has no preview: the stage ran, correctly produced nothing, and must never be retried.
 * The old pipeline had no way to say this -- "no output row" was indistinguishable from
 * "never ran" -- so the sweep re-queued those items every five minutes for the life of the
 * library (§7b).
 */
type JobHandler = (job: JobRow, signal: AbortSignal) => Promise<StageOutcome | void>;

/**
 * An unregistered kind fails loudly rather than silently succeeding, so a half-wired
 * pipeline is visible in the admin job view immediately.
 */
const handlers: Record<string, JobHandler> = {
    scan: runScan,
    probe: runProbe,
    cover: runCover,
    preview: runPreview,
    sprite: runSprite,
    ocr: runOcr,
    ocrTrial: runOcrTrial,
    ocrTune: runOcrTune,
    ocrMatch: runOcrMatch,
    mentionMatch: runMentionMatch,
    transcode: runTranscodeJob,
    variantPurge: runVariantPurge,
    index: runIndex,
    phash: runPhash,
    dupes: runDupes,
    embed: runEmbed,
    faces: runFaces,
    faceAnchors: runFaceAnchors,
    tagPictures: runTagPictures,
    tagLookPictures: runTagLookPictures,
    filehash: runFileHash,
    trash: runTrash,
    restore: runRestore,
    purge: runPurge,
    orphanSweep: runOrphanSweep,
};

let running = true;
let watchers: WatcherHandle | null = null;

/** The libraries currently being watched, as a comparable string. See `watchSet`. */
let watchedRoots = "";

/**
 * Rebuild the watchers if, and only if, the libraries have changed.
 *
 * Tearing them down and starting them again is not free — the watcher re-walks every
 * directory of the library to set up its watches — so doing it unconditionally on a timer would put a
 * recurring stat storm over the whole library in exchange for nothing. Comparing first makes
 * the common case a single indexed read.
 */
const syncWatchers = async (): Promise<void> => {
    const enabled = mediaRootRepo.listEnabledRoots();
    const signature = watchSignature(enabled);

    if (signature === watchedRoots) {
        return;
    }

    console.log(`Libraries changed; now watching ${enabled.length} librar(ies)`);

    await watchers?.close();
    watchers = await startWatchers(enabled);
    watchedRoots = signature;

    /**
     * A library that has just appeared has never been walked.
     *
     * Watching only reports what changes from now on, so without this the contents of a
     * newly added library would stay invisible until the next periodic sweep — which is the
     * bug this whole change exists to fix, merely moved one step later.
     */
    scheduleScan();
};
const inFlight = new Map<string, number>();

const busy = (kind: string): number => inFlight.get(kind) ?? 0;

/**
 * The kinds worth asking for, split by what may fill the remaining slots (§7c).
 *
 * The rules live in `claimableKinds` beside the limits they read; this only supplies the
 * handler set and the in-flight counts, which is the part that cannot leave this module.
 */
const availableKinds = (
    throttled: boolean,
    paused: boolean
): { free: string[]; requested: string[] } =>
    claimableKinds(Object.keys(handlers), busy, throttled, undefined, paused);

/**
 * Writes the stage row for a finished job.
 *
 * Only for jobs that *are* a registered stage. `scan`, `transcode` and `dupes` are real work
 * but not per-item processing state: a scan belongs to a root, a transcode is selected by
 * whether a browser can play the file rather than by whether it has been attempted, and a
 * dupes pass is a property of the library. Recording them here would answer a question nobody
 * asked and confuse the one the table exists for.
 */
/**
 * The user who asked for this pass, if anyone did.
 *
 * The column, not the payload. It used to be parsed back out of `payloadJson` because the
 * only reader was this function; the throttle made it a scheduling input as well (§7c), and
 * a fact the claim query has to filter on cannot live inside an opaque JSON blob.
 */
const requesterOf = (job: JobRow): string | null => job.requestedByUserId;

const recordStageOutcome = (
    job: JobRow,
    state: StageState,
    error?: unknown,
    permanent = false,
    recipe: string | null = null
): void => {
    const stage = findStage(job.kind);

    if (!stage || !job.mediaId) {
        return;
    }

    try {
        stageRepo.record({
            mediaId: job.mediaId,
            stage: stage.name,
            version: stage.version,
            state,
            detail: error instanceof Error ? error.message : null,
            // Set when a person asked for this pass rather than the sweep scheduling it. It
            // rides on the job because "queued" is not an outcome and must not occupy the
            // row before there is one.
            requestedByUserId: requesterOf(job),
            // Settle the stage along with the job, or the sweep offers the item again every
            // five minutes until the count gets there by itself.
            minimumAttempts: permanent ? (stage.maxAttempts ?? undefined) : undefined,
            recipe,
        });
    } catch (recordError) {
        // Bookkeeping must never turn a completed job into a failed one; the sweep will find
        // the item again, which is the safe direction to fail in.
        console.error(`Could not record stage ${job.kind} for ${job.mediaId}:`, recordError);
    }
};

/**
 * Say why a job stopped without finishing.
 *
 * Two things abort a handler and they want different words: somebody cancelled the work, or
 * the reclaim sweep decided this worker was gone and gave the job to someone else. The second
 * is worth noticing in the log — it means a handler blocked the event loop for a minute — so
 * the row is read rather than guessed at.
 */
const reportLostClaim = (job: JobRow): void => {
    const row = db.prepare(`SELECT "state" FROM "Job" WHERE "id" = ?`).get(job.id) as
        { state: string } | undefined;

    console.log(
        row?.state === "cancelled"
            ? `Job ${job.kind} ${job.id} cancelled`
            : `Job ${job.kind} ${job.id} lost its claim (now ${row?.state ?? "gone"}); stopping`
    );
};

/**
 * What a failed job was working on, for the log line -- the path, where there is one.
 *
 * A job id is useless once the row is gone and a media id means a query; the path is what
 * someone reading the log can hand straight to ffmpeg to see the failure for themselves.
 * Never throws: a lookup that fails must not replace the error being reported.
 */
const describeSubject = (job: JobRow): string => {
    if (job.fileId) {
        try {
            return resolveSource(job.fileId)?.absolutePath ?? `file ${job.fileId} (gone)`;
        } catch {
            return `file ${job.fileId}`;
        }
    }

    return job.mediaId ? `media ${job.mediaId}` : "";
};

const runJob = async (job: JobRow, throttled: boolean): Promise<void> => {
    inFlight.set(job.kind, (inFlight.get(job.kind) ?? 0) + 1);

    /**
     * Work somebody asked for runs at full tilt whatever the clock says (§7c).
     *
     * Throttling is a policy about *background* work. An admin who clicked "regenerate this
     * cover" is sitting in front of the page waiting for it, and a considerate pipeline that
     * makes the button feel broken has optimised the wrong thing.
     */
    const polite = throttled && !job.requestedByUserId;

    // Every kind, not only the ones with progress to report. A sprite job decodes the whole
    // source file and a purge copies it between volumes; both run well past the stale-claim
    // window, and an unheartbeated claim is reclaimed underneath a handler that is still
    // working.
    const { signal, stop } = startHeartbeat(db, job.id);

    try {
        const handler = handlers[job.kind];

        if (!handler) {
            throw new Error(`No handler registered for job kind "${job.kind}"`);
        }

        // Deleted or trashed since it was queued: nothing to do, and nothing went wrong.
        if (subjectGone(db, job)) {
            console.log(`Job ${job.kind} ${job.id} skipped: its item has left the library`);
            abandon(db, job.id);
            return;
        }

        /**
         * Not probed yet, so there is nothing to plan frames from (`needsProbe`).
         *
         * The sweep no longer offers these and the probe queues what follows it, so this
         * catches jobs queued before either was true. Dropped rather than failed: no attempt
         * is spent, and the sweep finds the item again once the probe has read it.
         */
        if (
            findStage(job.kind)?.needsProbe &&
            job.mediaId &&
            !mediaRepo.findBasic(job.mediaId)?.probedAt
        ) {
            console.log(`Job ${job.kind} ${job.id} dropped: its item has not been probed`);
            abandon(db, job.id);
            return;
        }

        /**
         * Its prerequisite has not settled (`requires`), so there is nothing to read yet.
         *
         * The sweep does not offer these; this catches a job requested or queued before the
         * prerequisite landed. Dropped rather than failed, as for the probe above: the sweep
         * finds the item again once the stage it waits for has run.
         */
        const waitingFor = (() => {
            const stage = findStage(job.kind);
            const kind = job.mediaId ? mediaRepo.findBasic(job.mediaId)?.kind : undefined;

            if (!stage || !kind || !job.mediaId) {
                return null;
            }

            const prerequisite = prerequisiteOf(stage, kind);
            const recorded = prerequisite
                ? (stageRepo.find(job.mediaId, prerequisite.name) ?? null)
                : null;

            return prerequisiteSettled(stage, kind, recorded) ? null : prerequisite;
        })();

        if (waitingFor) {
            console.log(
                `Job ${job.kind} ${job.id} dropped: its ${waitingFor.name} has not settled`
            );
            abandon(db, job.id);
            return;
        }

        // The politeness travels with the async stack rather than through every media-layer
        // signature, so the ffmpeg wrapper can read it at spawn time. See ./throttle.ts for
        // why it cannot be a module-level flag.
        const outcome = (await runWithPoliteness(polite, () => handler(job, signal))) ?? "done";

        if (signal.aborted) {
            reportLostClaim(job);
            return;
        }

        // Finished just as its item went: there is no stage row left to record it on.
        if (subjectGone(db, job)) {
            abandon(db, job.id);
            return;
        }

        // One place records every outcome, so a new capability needs a registry entry and a
        // handler and nothing else -- no column, no bespoke "is it done" convention, and no
        // fifth way of answering the same question.
        if (typeof outcome === "string") {
            recordStageOutcome(job, outcome);
        } else {
            recordStageOutcome(job, outcome.state, undefined, false, outcome.recipe);
        }
        complete(db, job.id);
    } catch (error) {
        // A cancelled handler throws on its way out, and that is not a failure: recording it
        // as one would dead-letter the job after three cancellations and leave a `failed`
        // stage row claiming the item cannot be processed.
        if (signal.aborted) {
            reportLostClaim(job);
            return;
        }

        /**
         * The file vanished under the handler because its item was deleted or trashed while
         * it ran. That is the deletion working, not the job failing: no retry, no dead letter,
         * no failed stage recorded against an item that no longer exists.
         */
        if (subjectGone(db, job)) {
            console.log(
                `Job ${job.kind} ${job.id} stopped: its item left the library while it ran`
            );
            abandon(db, job.id);
            return;
        }

        /**
         * A file that cannot be decoded fails the same way every time, so it is not retried
         * (`isUnreadableSource`). Changing the file is what earns it another attempt: the
         * scanner clears the item's failures when it sees different bytes.
         */
        const permanent = isUnreadableSource(error);
        const subject = describeSubject(job);

        // The stack rather than the error object. For a failed `execFile`, logging the object
        // also prints its `cmd`, `stdout` and `stderr` properties, which the message already
        // carries -- ffmpeg's complaint appeared three times per failure.
        console.error(
            `Job ${job.kind} ${job.id} failed${subject ? ` on ${subject}` : ""}` +
                `${permanent ? " (source unreadable; not retrying)" : ""}:`,
            error instanceof Error ? (error.stack ?? error.message) : error
        );
        recordStageOutcome(job, "failed", error, permanent);
        fail(db, job, error, { permanent });
    } finally {
        stop();
        inFlight.set(job.kind, (inFlight.get(job.kind) ?? 1) - 1);
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enqueue a library-wide scan if one is not already outstanding.
 *
 * The queue's partial unique index makes this idempotent, so the interval timer cannot pile
 * up scans behind a slow one — which is exactly what would happen on a first run over a
 * large share.
 */
const scheduleScan = (): void => {
    enqueue(db, { kind: "scan", priority: 10 });
};

/**
 * Ask for a reconciliation of `/data` against the database.
 *
 * Idempotent through the queue's partial unique index, so the timer cannot pile these up
 * behind a slow one. Low priority on purpose: it is housekeeping, and it must never sit in
 * front of the work somebody is waiting to see.
 */
const scheduleOrphanSweep = (): void => {
    enqueue(db, { kind: "orphanSweep", priority: 220 });
};

/**
 * Match every OCR string against the performers and sources once per boot (§5d).
 *
 * The job does nothing when the vocabulary is the one it last matched against, and a fresh
 * process has matched against none, so this pass is the one that runs in full -- and the one that
 * corrects pending counts that drifted while somebody tagged by hand. Low priority: nobody is
 * waiting on it.
 */
const scheduleOcrMatch = (): void => {
    enqueue(db, { kind: "ocrMatch", priority: 210 });
    // Which tags every item's text names (§5b "One rule for names"), for the same reason: a fresh
    // process has matched against no vocabulary, and this is the pass that fills or corrects it.
    enqueue(db, { kind: "mentionMatch", priority: 210 });
    // Performers' pictures from their confirmed faces (§6 "A tag's picture"): a pass that finds
    // every picture current is one query, and the first one after this shipped draws them all.
    enqueue(db, { kind: "tagPictures", priority: 210 });
    // Every performer's face reference and every face's best match (§5f "One face, one score"):
    // the first run after this shipped builds them; after that, grouping and decisions queue it.
    enqueue(db, { kind: "faceAnchors", priority: 210 });
};

/** Stages the sweep found nothing for, kept across passes (`IDLE_STAGE_RECHECK_MS`). */
const idleStages: IdleStages["seen"] = new Map();

/**
 * One sweep for everything that is behind.
 *
 * Transcoding stays separate and always will: it is selected by whether a browser can play
 * the file, which is a question about the file rather than about what has been done to it.
 * The stage table answers "has this been attempted"; that is a different question, and
 * folding them together would make both answers worse.
 */
const backfillArtifacts = (): number => {
    /**
     * Read every pass rather than cached at startup (§7b).
     *
     * An admin switching a stage on or off expects the sweep to notice, not to notice after
     * the next container restart — and this runs every five minutes, so the read is free.
     */
    const parsed = stagePolicySchema.safeParse(settingRepo.get(SETTING_KEYS.stagePolicy, {}));
    const policy = parsed.success ? parsed.data : {};

    return (
        backfillStages(db, policy, undefined, undefined, {
            mark: stageChangeMarks(policy),
            now: Date.now(),
            seen: idleStages,
        }) + backfillTranscodes()
    );
};

/**
 * Queue web-safe renditions for anything a browser cannot play (§8).
 *
 * Normally the probe job queues these as it finishes, so this finds nothing. It is here for
 * a library catalogued before the transcode pipeline existed, and for the case where an
 * admin switched transcoding off and later back on.
 *
 * The playability filter is the important part: the candidate query deliberately does not
 * apply it, because the verdict is TypeScript and expressing it in SQL would be a second
 * implementation that drifts. Without the filter this would transcode the whole library.
 *
 * **KNOWN ISSUE:** the candidate batch has no order or cursor, so it can be the same 500
 * direct-play files every pass and never reach the rest — see `listTranscodeCandidates`.
 */
const backfillTranscodes = (): number => {
    if (!transcodingEnabled()) {
        return 0;
    }

    const candidates = mediaRepo.listTranscodeCandidates(WEBSAFE_PROFILE, COVER_BACKFILL_BATCH);
    // Cancelled or already failed to exhaustion. Both must survive this sweep, or a stopped
    // job comes back within five minutes and an unencodable file is retried forever.
    const settled = settledMediaIds(db, "transcode");
    /**
     * Renditions retention reclaimed, which this sweep must not undo.
     *
     * Without this the two features cancel out exactly: the hourly sweep deletes a rendition
     * nobody has watched for a week, and five minutes later this queues the encode that
     * recreates it. Retention would cost a library its CPU and save it no disk at all.
     *
     * The item is not abandoned — it is reclaimed until wanted. Opening it queues the encode
     * again (§8), which is the whole difference between a cache and a deletion.
     */
    const evicted = variantRepo.evictedMediaIds();
    let queued = 0;

    for (const row of candidates) {
        if (assessPlayback(row).directPlay) {
            continue;
        }

        // Somebody stopped this one, or the encoder has already refused it three times.
        // Re-queuing either here would undo the decision within five minutes.
        if (settled.has(row.id)) {
            continue;
        }

        if (evicted.has(row.id)) {
            continue;
        }

        enqueue(db, {
            kind: "transcode",
            mediaId: row.id,
            fileId: row.fileId,
            priority: 200,
        });

        queued += 1;
    }

    return queued;
};

/**
 * How many expired entries one sweep purges.
 *
 * Bounded like every other sweep. An admin who drops the retention window to zero on a bin
 * holding thousands of items should get steady progress, not one pass that unlinks for
 * minutes while holding nothing else up.
 */
const PURGE_BATCH = 200;

/**
 * Queue the purge of everything whose window has closed (§10).
 *
 * The sweep only enqueues; the job does the deleting. That keeps one implementation of the
 * irreversible step — including its refusal to purge a file that is no longer trashed —
 * rather than a second copy here that would be the one running unattended.
 */
const sweepExpiredTrash = (): number => {
    const expired = trashRepo.listPurgeable(PURGE_BATCH);

    for (const entry of expired) {
        trashRepo.enqueueMove("purge", entry.id, entry.mediaId, entry.fileId);
    }

    return expired.length;
};

/**
 * Re-queue trash moves that were never made (§10).
 *
 * An entry whose bytes have not moved means a file the app believes it deleted is still
 * sitting in a media root — invisible in the library, present on disk, and reported to nobody.
 * The queue cannot find these itself: a job lost to a killed container leaves no row, and one
 * the unique index refused never had one.
 */
const sweepUnmovedTrash = (): number => {
    const owed = trashRepo.listAwaitingMove(PURGE_BATCH);

    for (const entry of owed) {
        trashRepo.enqueueMove("trash", entry.id, entry.mediaId, entry.fileId);
    }

    return owed.length;
};

/**
 * How many renditions one retention pass reclaims.
 *
 * Bounded for the same reason the trash purge is: an admin who drops the window from a year
 * to a day should get steady progress, not one pass that unlinks for minutes while the rest
 * of the pipeline waits behind it.
 */
const RETENTION_BATCH = 200;

/**
 * Reclaim renditions nobody has watched inside the window (§8).
 *
 * The bytes go and the row stays. That asymmetry is the design: the row is what tells the
 * five-minute backfill this item was reclaimed on purpose rather than never encoded, and it
 * is what lets opening the item queue the encode again. A deleted row would make the two
 * sweeps undo each other for ever.
 *
 * Done here rather than in a job, unlike the purge that follows switching transcoding off.
 * This is a bounded number of unlinks inside `dataDir` — not the cross-volume copy that
 * makes trashing a job (§10), and not the whole-library walk that makes the purge one.
 */
const sweepExpiredVariants = async (): Promise<number> => {
    const settings = loadTranscodeSettings();

    // Zero means keep them indefinitely. Checked before the query rather than passed into it,
    // because `datetime('now', '-0 days')` is simply now — which would reclaim everything.
    if (settings.retentionDays <= 0) {
        return 0;
    }

    const config = loadConfig();
    const variantRoot = dataPaths(config).variants;
    const expired = variantRepo.listExpired(settings.retentionDays, RETENTION_BATCH);

    for (const row of expired) {
        const absolutePath = path.resolve(config.dataDir, assertSafeRelativePath(row.relPath));

        // A path out of the database is checked exactly like one off the wire (§18.1).
        if (!absolutePath.startsWith(variantRoot + path.sep)) {
            console.warn(`Refusing to delete a variant outside ${variantRoot}: ${row.relPath}`);
            continue;
        }

        await rm(absolutePath, { force: true });
        variantRepo.markEvicted(row.id);
    }

    return expired.length;
};

const housekeeping = (): void => {
    const purged = refreshTokenRepo.purgeExpired();
    const stale = scanRepo.failStaleRunning();

    // The change feed is a feed, not history: nothing reads it but live connections, and a
    // browser away longer than the window resynchronises rather than replaying (§13b).
    const pruned = changeLogRepo.prune(CHANGE_LOG_RETENTION_MINUTES);

    const expiredTrash = sweepExpiredTrash();
    const owedMoves = sweepUnmovedTrash();

    if (purged > 0) console.log(`Purged ${purged} expired refresh token(s)`);
    if (expiredTrash > 0) console.log(`Queued ${expiredTrash} expired trash entr(ies) for purge`);
    if (owedMoves > 0) console.log(`Re-queued ${owedMoves} trash move(s) that never completed`);
    if (stale > 0) console.log(`Closed ${stale} interrupted scan(s)`);
    if (pruned > 0) console.log(`Pruned ${pruned} change feed row(s)`);

    // The queue is not history either, and it had no retention at all until the real library
    // reached 97,811 rows for 14,181 items (§20). Failures stay: they are what stops an
    // unencodable file being rediscovered every five minutes for ever. Not awaited, for the
    // reason the rendition sweep below is not: it pauses between batches by design.
    void pruneFinishedJobs()
        .then((finished) => {
            if (finished > 0) {
                console.log(`Pruned ${finished} finished job(s)`);
            }
        })
        .catch((error: unknown) => {
            console.warn(`Finished-job prune failed: ${(error as Error).message}`);
        });

    /**
     * Not awaited, and deliberately so.
     *
     * Housekeeping is called from an interval and everything else in it is synchronous.
     * Making the whole function async to accommodate one filesystem sweep would change how
     * every other part of it is scheduled; a failure here is logged and the next hour tries
     * again, which is the correct response to a busy disk.
     */
    void sweepExpiredVariants()
        .then((reclaimed) => {
            if (reclaimed > 0) {
                console.log(`Reclaimed ${reclaimed} unwatched rendition(s)`);
            }
        })
        .catch((error: unknown) => {
            console.warn(`Rendition retention sweep failed: ${(error as Error).message}`);
        });
};

/**
 * Start watching, then queue the startup scan, then the timers that follow both.
 *
 * Run once, when the startup grace ends (`startup.ts`). The libraries are read again here rather
 * than passed from boot: one added during the grace should be watched too, and the watch poll
 * starting afterwards would otherwise "discover" it and scan a second time.
 */
const startWatchingThenScan = async (
    watchEnabled: boolean,
    scanIntervalMinutes: number
): Promise<Array<() => void>> => {
    const stops: Array<() => void> = [];

    if (watchEnabled) {
        const enabled = mediaRootRepo.listEnabledRoots();

        watchers = await startWatchers(enabled);
        watchedRoots = watchSignature(enabled);

        if (enabled.length > 0 && watchers) {
            console.log(
                "Filesystem watching active. Note that inotify cannot see writes made by " +
                    "other machines to a remote share; the periodic scan covers that case."
            );
        }

        /**
         * Watching follows the libraries, on its own timer.
         *
         * Deliberately not inside the periodic-scan branch below. It used to be, which coupled
         * two unrelated things: switching periodic scanning off — a reasonable thing to do when
         * you trust filesystem events — also meant the watcher set was never rebuilt again, so
         * the very setting that says "rely on events" quietly stopped events from reaching a
         * library added afterwards.
         */
        stops.push(
            scheduleDeferred(ROOT_WATCH_POLL_MS, ROOT_WATCH_POLL_MS, () => void syncWatchers())
        );
    } else {
        console.log("Filesystem watching disabled by setting; relying on scheduled scans");
    }

    // One full pass after every start, which is what covers anything that changed while the
    // worker was not running to see the events. After the watchers, never before.
    scheduleScan();

    if (scanIntervalMinutes > 0) {
        console.log(
            `Periodic safety-net scan every ${scanIntervalMinutes} minute(s)` +
                (watchEnabled ? "; filesystem events handle everything in between" : "")
        );

        const everyMs = scanIntervalMinutes * 60 * 1000;

        stops.push(scheduleDeferred(everyMs, everyMs, scheduleScan));
    } else {
        console.log(
            "Periodic scanning is switched off. Changes are picked up from filesystem events " +
                "only, so anything written to a remote share by another machine will not be seen " +
                "until someone scans manually."
        );
    }

    return stops;
};

const main = async (): Promise<void> => {
    const config = loadConfig();
    ensureDataDirs(config);

    console.log(`private-stock worker ${WORKER_ID}`);
    console.log(`  data:  ${config.dataDir}`);
    console.log(`  media: ${config.mediaDir}`);

    // Recover whatever was in flight when this container was last killed.
    const reclaimed = reclaimStaleJobs(db);
    if (reclaimed > 0) {
        console.log(`Reclaimed ${reclaimed} job(s) from a previous run`);
    }

    // Nothing can be scanning before this process starts one, so any running row is dead.
    const interrupted = scanRepo.failStaleRunning(0);
    if (interrupted > 0) {
        console.log(`Closed ${interrupted} scan(s) interrupted by the last restart`);
    }

    const roots = mediaRootRepo.listRoots();
    const enabled = roots.filter((root) => root.enabled);
    console.log(
        `${roots.length} librar(ies), ${enabled.length} enabled: ` +
            (roots.map((root) => `${root.label}${root.enabled ? "" : " (disabled)"}`).join(", ") ||
                "none — add one in the admin page")
    );

    const scanIntervalMinutes = settingRepo.get(
        "scan.intervalMinutes",
        DEFAULT_SCAN_INTERVAL_MINUTES
    );
    const watchEnabled = settingRepo.get("scan.watch", true);

    /**
     * Only what correctness needs runs now; the rest waits for the startup grace (`startup.ts`).
     *
     * Everything below is either cheap and continuous (reclaiming stale claims, the WAL
     * checkpoint) or deferred to a fixed point after the grace. Each periodic timer is counted
     * from its first run rather than from boot, so the passes stay apart afterwards too.
     */
    const bootedAt = Date.now();

    console.log(
        `Startup grace: background work waits ${Math.round(STARTUP_GRACE_MS / 1000)} s so the ` +
            "site's first page loads are not competing with it for the disk; requested work " +
            "runs now"
    );

    const stops: Array<() => void> = [
        scheduleDeferred(RECLAIM_INTERVAL_MS, RECLAIM_INTERVAL_MS, () => reclaimStaleJobs(db)),
        scheduleDeferred(WAL_CHECKPOINT_INTERVAL_MS, WAL_CHECKPOINT_INTERVAL_MS, () => {
            try {
                checkpointWal(db);
            } catch (error) {
                // Housekeeping, not correctness: the next pass, or any commit past the mark,
                // does the same work.
                console.warn(`WAL checkpoint failed: ${(error as Error).message}`);
            }
        }),

        // Native memory behind small objects goes back only when they are collected (memory.ts).
        scheduleDeferred(COLLECT_INTERVAL_MS, COLLECT_INTERVAL_MS, collectGarbage),

        /**
         * Watching first, then the startup scan — the order is the guarantee.
         *
         * The scan is what covers anything that changed while the worker was not running to
         * see the events, and it still runs on every boot, only later. Enqueued once the
         * watchers are up, so nothing falls between the two: a change before the scan walks
         * past it is seen by the scan, a change after is seen by the watchers.
         */
        scheduleDeferred(firstRunAfter("watchAndScan"), null, () => {
            void startWatchingThenScan(watchEnabled, scanIntervalMinutes).then((stopMore) => {
                stops.push(...stopMore);
            });
        }),

        scheduleDeferred(firstRunAfter("sweep"), COVER_BACKFILL_INTERVAL_MS, () => {
            const backfilled = backfillArtifacts();

            if (backfilled > 0) {
                console.log(
                    `Queued ${backfilled} artifact job(s) for items that were missing some`
                );
            }
        }),

        scheduleDeferred(firstRunAfter("housekeeping"), HOUSEKEEPING_INTERVAL_MS, housekeeping),

        scheduleDeferred(firstRunAfter("housekeeping"), null, scheduleOcrMatch),

        // Sources' and keywords' pictures from their looks: at startup, then daily.
        scheduleDeferred(firstRunAfter("housekeeping"), LOOK_PICTURES_INTERVAL_MS, () => {
            enqueue(db, { kind: "tagLookPictures", priority: 210 });
        }),

        // Last, and by a distance: the heaviest sweep, and the one whose startup pass (a reset
        // or restored database beside an older `/data`, §13d) loses nothing by waiting.
        scheduleDeferred(
            firstRunAfter("orphanSweep"),
            ORPHAN_SWEEP_INTERVAL_MS,
            scheduleOrphanSweep
        ),
    ];

    let wasPaused = false;
    let wasHolding = true;

    while (running) {
        // Read every pass rather than on a timer. The settings themselves are cached for
        // half a minute; what is not cached is the clock, and the whole feature is a
        // boundary the loop has to notice within a couple of seconds of it arriving.
        const { throttled } = throttleState();
        const paused = processingPaused();
        // Background work waits out the startup grace like a pause: requested work and the
        // bin's moves still run (`startup.ts`).
        const holding = inStartupGrace(bootedAt, Date.now(), firstRunAfter("claimBackground"));

        if (wasHolding && !holding) {
            console.log("Startup grace over; background work resumes");
            wasHolding = false;
        }

        // Said once per change rather than every pass, so the log shows when the queue was
        // held and when it was let go (§7c "Pausing").
        if (paused !== wasPaused) {
            console.log(
                paused
                    ? "Processing paused: only requested work and the bin's moves will run"
                    : "Processing resumed"
            );
            wasPaused = paused;
        }

        const { free: open, requested } = availableKinds(throttled, paused || holding);
        // Kept on the model family the child holds while it has work, so embed and faces do
        // not alternate item by item, reloading models each time (`embed/affinity.ts`).
        const held = heldFamily();
        const free = held === null ? open : withAffinity(open, held, modelKindsWaited(db));
        const job = claimNext(db, free, WORKER_ID, requested);

        if (!job) {
            await sleep(IDLE_POLL_MS);
            continue;
        }

        // Not awaited: the loop keeps claiming up to each kind's concurrency limit.
        void runJob(job, throttled);
    }

    stops.forEach((stop) => stop());
    await watchers?.close();
    // Its IPC channel would otherwise hold this process open until the idle timer fired.
    stopModelChild();
};

const shutdown = (signal: string): void => {
    console.log(`Received ${signal}, finishing in-flight work...`);
    running = false;
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((error) => {
    console.error("Worker failed to start:", error);
    process.exit(1);
});
