/**
 * The worker's first minutes belong to the website (§20).
 *
 * Every deploy restarts both processes, and the first thing anybody does after one is open the
 * site to see whether it came back. The worker used to choose exactly that moment to do all of
 * its heavy reading at once: the startup scan stat-ed the whole library while the watcher walked
 * it again to set up watching, the stage sweep ran its candidate query for every stage, the
 * orphan sweep read all of `Artifact` three times and walked `/data/art`, the hourly
 * housekeeping deleted a backlog of finished jobs, and whatever the last run left queued started
 * spawning ffmpeg. On a NAS whose one volume holds the media and the database, a page the web
 * process needs is then a ~100 ms disk read behind all of that, and the first page load after a
 * deploy took 43 s.
 *
 * None of it was needed at that moment, only eventually. So the worker boots in two halves:
 *
 * - **At once**, only what correctness needs: recovering the claims a killed container left
 *   behind, the WAL checkpoint, and claiming work somebody *asked* for (§7c's requested
 *   exemption — someone is waiting on it) plus the bin's moves (a deletion already made).
 *   Migrations ran in the entrypoint before this process started.
 * - **After the grace**, everything else, staggered so it does not all land in the same minute
 *   instead of the first one: background claiming, then watching and the startup scan, then the
 *   stage sweep, then housekeeping, and the orphan sweep last because it is the heaviest.
 *
 * Nothing is dropped, only moved. The startup scan still runs on every boot and is still what
 * picks up changes made while the container was down; it is enqueued only once the watchers are
 * up, so between the two nothing can slip through — what changes before the scan walks is seen
 * by the scan, what changes after it is seen by the watchers. The cost is latency: a file dropped
 * into a library in the first minutes after a deploy appears when the grace ends, not at once.
 *
 * One number, so the schedule cannot drift into a scatter of unrelated delays: every deferred
 * step is a multiple of the grace.
 */

/**
 * How long after boot the worker stays out of the way.
 *
 * Five minutes in production: long enough for a deploy, the reload that follows it and a first
 * browse of the library to happen on a quiet disk. Development restarts the worker on every save
 * (`tsx watch`), and five minutes of nothing after each one would read as the worker being
 * broken, so it is short there.
 */
export const STARTUP_GRACE_MS = process.env.NODE_ENV === "production" ? 5 * 60_000 : 15_000;

/** The work that waits for the grace to end. */
export type DeferredStep =
    "claimBackground" | "watchAndScan" | "sweep" | "housekeeping" | "orphanSweep";

/**
 * When each deferred step first runs, as a multiple of the grace.
 *
 * At the default five minutes: background claiming and the startup scan at 5:00, the stage
 * sweep at 7:00, housekeeping at 9:00 and the orphan sweep at 20:00. Each periodic timer is then
 * counted from that first run, so the staggering lasts — the five-minute, hourly and daily passes
 * stay apart instead of firing together forever after because they all started at boot.
 *
 * The scan comes before the sweep on purpose: a scan that adds items queues their probes, and a
 * sweep that ran first would only find the same items again a pass later. The orphan sweep is
 * last because it is the heaviest thing the worker does that nobody is waiting for — a walk of
 * `/data/art` and a read of every artifact row — and its startup pass (noticing a reset or
 * restored database beside an older `/data`, §13d) loses nothing by being a quarter of an hour
 * late.
 */
const STEP_AT: Record<DeferredStep, number> = {
    claimBackground: 1,
    watchAndScan: 1,
    sweep: 1.4,
    housekeeping: 1.8,
    orphanSweep: 4,
};

export const firstRunAfter = (step: DeferredStep, graceMs: number = STARTUP_GRACE_MS): number =>
    Math.round(graceMs * STEP_AT[step]);

/** Is the worker still inside its startup grace? */
export const inStartupGrace = (
    bootedAt: number,
    now: number,
    graceMs: number = STARTUP_GRACE_MS
): boolean => now - bootedAt < graceMs;

/**
 * Run `task` once after `firstMs`, then every `everyMs` counted from that first run.
 *
 * Returns the means to stop it, whichever of the two timers is live. `everyMs` null runs it once.
 * A failure is the task's to report: this only schedules.
 */
export const scheduleDeferred = (
    firstMs: number,
    everyMs: number | null,
    task: () => void
): (() => void) => {
    let interval: ReturnType<typeof setInterval> | null = null;

    const timeout = setTimeout(() => {
        task();

        if (everyMs !== null) {
            interval = setInterval(task, everyMs);
        }
    }, firstMs);

    return () => {
        clearTimeout(timeout);

        if (interval) {
            clearInterval(interval);
        }
    };
};
