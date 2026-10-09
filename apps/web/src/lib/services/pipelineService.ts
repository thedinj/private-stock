import {
    SETTING_KEYS,
    STAGES,
    DEFAULT_THROTTLE_SETTINGS,
    PROCESSING_POLL_MS,
    effectiveTimeZone,
    hourIn,
    isThrottled,
    processingIsActive,
    scanDenominator,
    stageProgress,
    throttleChangesAt,
    throttleSettingsSchema,
    timeZoneOffsetLabel,
    type ProcessingStatus,
    type ThrottleSettings,
} from "@private-stock/core";
import {
    db,
    jobRepo,
    mediaRepo,
    mediaRootRepo,
    scanRepo,
    settingRepo,
    stageRepo,
} from "@private-stock/db";

/**
 * How long a busy answer is reused: a little under the client's poll, so a viewer polling it
 * always gets a fresh one and the cache only saves the second tab, the second admin, and the
 * sidebar badge asking in the same moment. Progress is never hidden longer than the poll hides it.
 */
const BUSY_TTL_MS = PROCESSING_POLL_MS - 500;

/**
 * How long an idle answer is reused. An idle library's numbers change only when somebody changes
 * something here -- which clears this (`clearProcessingCache`) -- or when work starts, which
 * every reuse checks for first (`workStarted`). So the minute bounds only what neither sees.
 */
const IDLE_TTL_MS = 60_000;

/** The library-wide half of the answer: the same for every admin, so one entry. */
type ProcessingSnapshot = {
    at: number;
    busy: boolean;
    settings: ThrottleSettings;
    status: Pick<ProcessingStatus, "scan" | "stages" | "queue">;
};

let cache: ProcessingSnapshot | null = null;

/**
 * Throws the cached answer away.
 *
 * Called by everything in this process that changes what the view would say -- a scan asked
 * for, a stage requested, failures retried, settings saved (policy, quiet hours, pause), and
 * through `clearLibraryCaches` every library and trash change. The client invalidates its own
 * copy at the same moments (`invalidateProcessing`), and its refetch must not be handed the
 * answer from before the click.
 */
export const clearProcessingCache = (): void => {
    cache = null;
};

/**
 * Whether work has begun since an idle answer was cached: a scan running, or anything queued.
 * Two descents of partial indexes, ~2 pages, against the ~120 the full answer costs cold.
 */
const workStarted = (): boolean => scanRepo.isAnyRunning() || jobRepo.anyLive();

/**
 * The processing view (§13c).
 *
 * A handful of aggregates and no per-item detail, because this is polled every couple of
 * seconds while work is running and the whole point is to be cheaper than the work it is
 * describing. Everything with judgement in it — denominators, stale recipe versions, the
 * clamping — lives in `@private-stock/core`, where it is tested without a database.
 *
 * Admin-scoped at the route, and global rather than per-root: it counts the whole library, so
 * there is nothing here that a user restricted to one library should see -- and nothing that
 * differs between the admins who can, which is what lets one cached answer serve them all.
 *
 * **What it costs** (§20). Opening this page froze the site for 9–15 s on the NAS: ~6,800 pages
 * of counting, on the thread that serves every request, and inside an `IMMEDIATE` transaction
 * (the web default) that held the write lock while it read, so the worker's job claim waited
 * behind it too. The stage totals now come from a trigger-maintained tally and the denominator
 * from an index of its own; the whole answer is ~120 pages cold, read under one deferred
 * transaction so the statements share a snapshot and its cache, and never the write lock.
 *
 * Cached for `BUSY_TTL_MS` while work runs and `IDLE_TTL_MS` while it does not; the throttle and
 * the clock are worked out per request from the cached settings, because they move with the
 * time rather than the database.
 */
export const getProcessingStatus = (): ProcessingStatus => {
    const now = Date.now();
    const fresh =
        cache !== null &&
        now - cache.at < (cache.busy ? BUSY_TTL_MS : IDLE_TTL_MS) &&
        (cache.busy || !workStarted());
    const snapshot = fresh && cache ? cache : readSnapshot(now);

    cache = snapshot;

    const date = new Date(now);
    const zone = effectiveTimeZone(snapshot.settings.timeZone);
    const hour = hourIn(zone, date);

    return {
        ...snapshot.status,
        throttle: describeThrottle(snapshot.settings, hour),
        serverClock: {
            hour,
            timeZone: zone,
            offsetLabel: timeZoneOffsetLabel(zone, date),
            source: snapshot.settings.timeZone ? "configured" : "host",
        },
    };
};

/**
 * Every statement under one deferred transaction (§20), as `getHome` reads its shelves: one
 * snapshot, so the counts agree with each other and share the pages they read, and deferred
 * rather than the web default `IMMEDIATE`, because a read must not take the write lock.
 */
const readSnapshot = (now: number): ProcessingSnapshot =>
    db
        .transaction((): ProcessingSnapshot => {
            const running = scanRepo.currentRun();
            const queue = jobRepo.queueSummary();
            const status = {
                scan: running ? describeScan(running) : null,
                // With what is queued, so a stage whose items all have an outcome but which has
                // work queued again -- a repair, a re-run -- does not claim to be complete.
                stages: stageProgress(
                    mediaRepo.countProcessable(),
                    stageRepo.summary(),
                    STAGES,
                    Object.fromEntries(
                        queue.byKind.map((row) => [row.kind, row.pending + row.claimed])
                    )
                ),
                queue,
            };

            return {
                at: now,
                busy: processingIsActive(status),
                settings: throttleSettings(),
                status,
            };
        })
        .deferred();

/**
 * The stored window, or the defaults when the row is absent or unparseable.
 *
 * Failing to full speed rather than throwing, for the same reason the worker does (§7c): a
 * malformed settings row must not take down the page that would let somebody fix it.
 */
const throttleSettings = () => {
    const parsed = throttleSettingsSchema.safeParse(settingRepo.get(SETTING_KEYS.throttle, {}));

    return parsed.success ? parsed.data : DEFAULT_THROTTLE_SETTINGS;
};

/**
 * What the throttle is doing (§7c).
 *
 * Computed here rather than read from the worker, because there is nothing to read: the
 * throttle is a pure function of a settings row and the time, and the worker records no
 * state about it. The two processes share a container and therefore a clock, and now also
 * share the zone that clock is read in, so they agree.
 *
 * Null when no window is configured, which the view renders as nothing at all rather than as
 * "not throttled" -- a badge saying a feature is off is noise on every library that never
 * turns it on. The clock is deliberately *not* part of this and is reported separately: it
 * used to be nested here, and so was invisible on exactly the libraries where somebody was
 * about to configure the window and needed it.
 */
const describeThrottle = (
    settings: ThrottleSettings,
    hour: number
): ProcessingStatus["throttle"] => {
    const changesAtHour = throttleChangesAt(settings, hour);

    if (changesAtHour === null) {
        return null;
    }

    return { active: isThrottled(settings, hour), changesAtHour };
};

const describeScan = (run: NonNullable<ReturnType<typeof scanRepo.currentRun>>) => {
    const root = mediaRootRepo.findById(run.rootId);

    return {
        rootId: run.rootId,
        // A scan of a library that was removed mid-walk still has to render. Falling back to
        // the id is ugly and honest; throwing would take the whole page down over a label.
        rootLabel: root?.label ?? run.rootId,
        filesSeen: run.filesSeen,
        filesAdded: run.filesAdded,
        filesChanged: run.filesChanged,
        filesMoved: run.filesMoved,
        estimatedTotal: scanDenominator(scanRepo.lastCompletedFilesSeen(run.rootId), run.filesSeen),
        startedAt: run.startedAt,
    };
};
