import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

import {
    DEFAULT_THROTTLE_SETTINGS,
    SETTING_KEYS,
    effectiveTimeZone,
    hourIn,
    isThrottled,
    processingPauseSchema,
    throttleSettingsSchema,
    throttledThreads,
    type ThrottleSettings,
} from "@private-stock/core";
import { settingRepo } from "@private-stock/db";

/**
 * How hard the worker is allowed to push right now (§7c).
 *
 * Three levers, because no one of them is sufficient on its own:
 *
 *  - **Concurrency** -- fewer slots per kind. Real for the kinds that run several at once,
 *    and worth nothing for `transcode`, which is pinned at one at every hour of the day.
 *  - **Process priority** -- ffmpeg yields under contention. Helps every kind, guarantees
 *    nothing: `nice` decides who wins a fight for the CPU, not how much of an idle CPU a
 *    process takes, and it does not touch I/O or memory bandwidth at all.
 *  - **Encoder threads** -- a hard ceiling, and the only lever that actually bites on the
 *    one job that saturates the box for minutes at a time.
 */

/**
 * Concurrency per job kind, at full speed.
 *
 * `transcode: 1` is the important one -- a NAS transcoding two files at once has nothing left
 * for serving pages, and the app feels broken rather than busy. `scan: 1` because two
 * concurrent walks of the same share contend for the same slow I/O and finish slower than
 * one.
 */
export const CONCURRENCY: Record<string, number> = {
    scan: 1,
    probe: 2,
    parse: 2,
    cover: 2,
    sprite: 1,
    preview: 1,
    phash: 2,
    // A sheet decode per hundred tiles, from /data. One slot keeps it behind the work people see.
    tileprint: 1,
    // One whole MPEG-TS file read per job (§8). I/O, and one at a time for the reason the
    // trash's copies are: two reads from the same disks halve each other.
    segments: 1,
    // I/O bound rather than CPU bound, and on a network share the bottleneck is the share
    // itself — more concurrency would slow the same total work down.
    filehash: 2,
    // A single whole-library pass that writes shared groups. Two at once would build
    // overlapping groups from each other's half-written rows.
    dupes: 1,
    websafeCheck: 2,
    transcode: 1,
    // A whole-library walk that deletes. Two at once would race over the same rows for no
    // gain, and the work is one volume's I/O either way.
    variantPurge: 1,
    index: 2,
    // One header read per file, like the probe's.
    metadata: 2,
    // One at a time, and for a different reason than transcoding: these copy whole files
    // between volumes, so two at once halve each other's throughput and the second one is
    // waiting on the same disk either way.
    trash: 1,
    restore: 1,
    purge: 1,
    // A whole-tree walk that deletes. Two at once would race each other over the same files
    // for no gain, since the work is I/O on one volume.
    orphanSweep: 1,
    // One embedder child process serves every embed job (§5e), so a second slot would only
    // queue behind the first inside it.
    embed: 1,
    // The same child serves faces, one family at a time (§5f): a second slot would only wait.
    faces: 1,
    // Library-wide and replaces every reference and match whole (§5f "One face, one score").
    // Not in `CPU_BOUND`: a pass is seconds of arithmetic and one read of every faces file, and in the
    // shared budget it waited behind every `faces` job of a first pass — hours — so nothing it
    // feeds was ever up to date.
    faceAnchors: 1,
    // Library-wide, and replace each tag's picture files in place.
    tagPictures: 1,
    tagLookPictures: 1,
    reelRender: 1,
    backup: 1,
};

/**
 * Concurrency outside the window, for the kinds that saturate a core.
 *
 * Exceptions rather than a second full table, which is the same direction `stages.disabled`
 * takes and for the same reason: a kind added later is then at full speed by default, because
 * nobody has decided it is heavy. The opposite scheme would quietly throttle every new
 * capability in every library until someone noticed.
 *
 * `probe` is deliberately absent. It is cheap, and it gates every other stage -- slowing it
 * would leave a freshly imported item with no duration and no dimensions for hours, which
 * reads as a broken import rather than as a considerate one.
 */
export const THROTTLED: Record<string, number> = {
    cover: 1,
    sprite: 1,
    preview: 1,
    phash: 1,
    /**
     * None: outside the window only requested embeds run (§5e, §7c). The one kind stopped
     * rather than slowed, because its cost is not only a core. The child holds ~210 MB of model
     * for as long as there is a backlog — on the NAS, every hour of a day-long first pass —
     * and that is memory taken from the page cache and, under the host's pressure, the web
     * process's pages pushed to swap. A single slot was no throttle at all: `embed` only ever
     * had one. Waiting costs nothing anyone sees until the search is built on it, and the stage's
     * opt-in already promises it runs inside the quiet hours.
     */
    embed: 0,
    /** None, for `embed`'s reasons: the face models hold ~230 MB while they work (§5f). */
    faces: 0,
    transcode: 1,
};

/**
 * The kinds that hold a core while they run, and so share one budget (§7c).
 *
 * The per-kind table above bounds each kind and nothing bounds their sum: at full speed the
 * limits add up to 26 concurrent jobs, and throttling brings that to 24, because it caps five
 * kinds by a single slot each. Nine of those 26 spawn ffmpeg or decode frames. On a four-core
 * NAS that is nine processes competing for four cores with the web server, which is what a
 * seizing UI actually was — the web process was not slow, it was not being scheduled.
 *
 * Membership is about holding a *core*, not about doing work. `scan`, `filehash`, `trash` and
 * the sweeps are I/O against a share or the data volume; capping those by core count would slow
 * the library down to protect a CPU they were never using.
 *
 * `probe` and `websafeCheck` are deliberately outside it, for the reason `THROTTLED` leaves
 * `probe` out: they are short, they gate every other stage, and an item with no duration and
 * no dimensions reads as a broken import rather than a considerate one.
 */
export const CPU_BOUND: ReadonlySet<string> = new Set([
    "cover",
    "preview",
    "sprite",
    "ocr",
    // The OCR test bench reads frames exactly as `ocr` does (§5d), so it holds a core the same way.
    "ocrTrial",
    // The OCR tuner reads frames the same way, to fill its cache (§5d).
    "ocrTune",
    "phash",
    // Brief, but each sheet is an ffmpeg decode.
    "tileprint",
    // The model saturates whatever threads it is given, the per-job cap included (§5e).
    "embed",
    // Detection and recognition both saturate the threads they are given (§5f).
    "faces",
    // Decodes a frame of the original at full size, as `cover` does (§6 "A tag's picture").
    "tagPictures",
    "tagLookPictures",
    "transcode",
    "reelRender",
]);

/**
 * Cores the *container* may use, from its cgroup quota, or null when there is no limit.
 *
 * `os.cpus()` reports the machine, not the allowance. A container under `cpus: 2.0` on a
 * four-core NAS sees four, so a budget derived from it hands out three CPU-bound slots against
 * two cores' worth of quota — over-subscribed by exactly the margin the budget exists to hold
 * back, and invisible because every tool inside the container agrees there are four cores.
 *
 * Both cgroup layouts, because QTS kernels are not reliably v2: v2 states quota and period on
 * one line as `max 100000` or `200000 100000`; v1 keeps them in two files and writes `-1` for
 * no limit.
 *
 * Pure, so the parsing is testable without a cgroup to read.
 */
export const quotaCores = (
    cpuMax: string | null,
    cfsQuota: string | null,
    cfsPeriod: string | null
): number | null => {
    if (cpuMax) {
        const [quota, period] = cpuMax.trim().split(/\s+/);

        if (quota && quota !== "max" && period) {
            const cores = Number(quota) / Number(period);

            return Number.isFinite(cores) && cores > 0 ? cores : null;
        }
    }

    if (cfsQuota && cfsPeriod) {
        const quota = Number(cfsQuota.trim());
        const period = Number(cfsPeriod.trim());

        if (quota > 0 && period > 0) {
            return quota / period;
        }
    }

    return null;
};

const readIfPresent = (path: string): string | null => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // No cgroup here at all -- the Windows dev box, or a kernel using the other layout.
        return null;
    }
};

/**
 * Cores to budget against: the quota when one is set, otherwise the machine's.
 *
 * Read once. A cgroup limit does not change under a running container, and this is consulted
 * from the claim loop.
 */
let effective: number | null = null;

export const effectiveCores = (): number => {
    if (effective === null) {
        const quota = quotaCores(
            readIfPresent("/sys/fs/cgroup/cpu.max"),
            readIfPresent("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
            readIfPresent("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        );

        const host = cpus().length;

        // Floor, not round: 2.5 cores of quota must not license three jobs. Never below one.
        effective = quota === null ? host : Math.max(1, Math.min(host, Math.floor(quota)));
    }

    return effective;
};

/**
 * How many CPU-bound jobs may run at once, across every kind.
 *
 * **One core is held back at full speed**, which is the entire point: the web process serves on
 * a single thread and `better-sqlite3` is synchronous, so a request that cannot get scheduled
 * is indistinguishable from a slow query from outside the process (§20). Leaving a core is the
 * only lever here that changes that, because the other three all assume the contended resource
 * gets shared eventually rather than reserved.
 *
 * Halved again inside the window, where the premise is that somebody is using the NAS.
 *
 * This binds only where it is needed. On the 32-core dev box the budget is larger than the
 * per-kind limits can fill, so nothing changes; on a two-core NAS it serialises media work,
 * which on a two-core NAS is the correct answer.
 */
export const cpuSlots = (throttled: boolean, cores: number = effectiveCores()): number => {
    const full = Math.max(1, cores - 1);

    return throttled ? Math.max(1, Math.floor(full / 2)) : full;
};

/**
 * Threads one CPU-bound job may give ffmpeg (or tesseract), so that a slot really is a core.
 *
 * `cpuSlots` holds a core back by counting *jobs*, which only works if a job occupies one core.
 * ffmpeg does not: it sizes its thread pools from the cores it can see, and inside a container
 * that is the host's, so one sprite or preview under `cpus: 2.0` on a four-core NAS ran four
 * threads and spent the whole quota by itself. The kernel then froze the entire container —
 * the web process included — for the rest of each 100 ms period: measured at 48% of periods
 * throttled (§20). `nice` does not help against that; it decides who runs inside the quota, not
 * whether the quota runs out.
 *
 * So the budget is stated in threads as well: the cores left after the web process's one,
 * shared by as many CPU-bound jobs as can actually run together. On the NAS that is one thread.
 * On the 32-core dev box the per-kind limits cannot fill the slots, so each job gets several.
 *
 * Full-speed figures deliberately: inside the window fewer jobs run, and the transcode job
 * applies the window's own cap on top of this.
 */
export const threadsPerJob = (cores: number = effectiveCores()): number => {
    const runnable = [...CPU_BOUND].reduce((total, kind) => total + limitFor(kind, false), 0);
    const concurrent = Math.max(1, Math.min(cpuSlots(false, cores), runnable));

    // Never zero: `-threads 0` is ffmpeg for "every core", the one value this exists to prevent.
    return Math.max(1, Math.floor((cores - 1) / concurrent));
};

/** Slots this kind may occupy. Falls back to one, so an unlisted kind is never unbounded. */
export const limitFor = (kind: string, throttled: boolean): number => {
    const full = CONCURRENCY[kind] ?? 1;

    return throttled ? Math.min(full, THROTTLED[kind] ?? full) : full;
};

/**
 * Which kinds the claim loop may ask for, and on what terms.
 *
 * `free` has room under whatever limit applies right now. `requested` has run out of room under
 * the throttled limit but not under the full one, so only work somebody asked for may go there
 * -- which is the exemption, and the reason it costs one extra list rather than a second pass
 * over the queue.
 *
 * The per-kind limits are then capped by one shared CPU budget, because their sum is 26 and
 * nothing was bounding it. Only `CPU_BOUND` kinds are withheld when it is full, so a scan or a
 * file hash -- I/O against the share, not a core -- keeps going while ffmpeg work waits.
 *
 * **The budget is not lifted for requested work**, and that is the one place this departs from
 * the exemption above. The window is a *policy* about when background work is welcome, and a
 * person waiting on a button is a good reason to ignore it. The budget is a statement about how
 * many cores exist, which no amount of wanting changes: a requested job let through a full
 * budget would take its core from the web process serving the page that asked for it.
 *
 * Pure, and takes `busy` rather than reading it, because the claim loop lives in a module that
 * starts a worker when it is imported and so cannot be reached from a test.
 */
export const claimableKinds = (
    kinds: string[],
    busy: (kind: string) => number,
    throttled: boolean,
    cores?: number,
    /** Background processing paused (§7c "Pausing"): see `pausedKinds`. */
    paused = false
): { free: string[]; requested: string[] } => {
    const open = claimableUnpaused(kinds, busy, throttled, cores);

    return paused ? pausedKinds(open) : open;
};

/**
 * Kinds that keep running through a pause: the bin's moves.
 *
 * A trash, restore or purge is a deletion somebody already made, and the item is hidden from
 * the moment it was asked for. Holding the move would leave it neither here nor gone, and
 * pausing to tune OCR has no reason to stop it.
 */
export const PAUSE_EXEMPT: ReadonlySet<string> = new Set(["trash", "restore", "purge"]);

/**
 * What may be claimed while paused (§7c "Pausing").
 *
 * Every kind that had room becomes *requested only*: work somebody asked for — the OCR test
 * bench, a tuning run, a stage run from an item's page — still runs, which is what lets an
 * administrator tune settings while the library waits for them. Background work stays queued,
 * and the queue keeps filling as scans and sweeps add to it, so resuming carries on where the
 * pause left off. The CPU budget still applies to what does run; a pause is not a reason to
 * let requested work take the web process's core.
 */
export const pausedKinds = (open: { free: string[]; requested: string[] }) => ({
    free: open.free.filter((kind) => PAUSE_EXEMPT.has(kind)),
    requested: [...open.free.filter((kind) => !PAUSE_EXEMPT.has(kind)), ...open.requested],
});

const claimableUnpaused = (
    kinds: string[],
    busy: (kind: string) => number,
    throttled: boolean,
    cores?: number
): { free: string[]; requested: string[] } => {
    const free: string[] = [];
    const requested: string[] = [];

    let cpuRunning = 0;
    for (const kind of CPU_BOUND) {
        cpuRunning += busy(kind);
    }

    const cpuFull = cpuRunning >= cpuSlots(throttled, cores);

    for (const kind of kinds) {
        if (cpuFull && CPU_BOUND.has(kind)) {
            continue;
        }

        const running = busy(kind);

        if (running < limitFor(kind, throttled)) {
            free.push(kind);
        } else if (throttled && running < limitFor(kind, false)) {
            requested.push(kind);
        }
    }

    return { free, requested };
};

/**
 * Below normal priority, for the ffmpeg children of throttled work.
 *
 * Node's own scale rather than a raw nice value, so this works on the Windows dev box
 * (`BELOW_NORMAL_PRIORITY_CLASS`) and in the Linux container (`nice 10`) without a branch.
 *
 * Priority is only ever *lowered*, and never restored. That is not tidiness: on POSIX an
 * unprivileged process may lower its priority and may not raise it again, so a design that
 * niced the worker itself and tried to undo it would need CAP_SYS_NICE in the container. Each
 * ffmpeg child is spawned fresh at the parent's priority, so there is nothing to put back.
 */
export const POLITE_PRIORITY = 10;

/** What the pipeline is allowed to do at this moment. */
export interface ThrottleState {
    /** Whether background work is being held back at all. */
    throttled: boolean;
    /** Encoder thread cap for background transcodes, or null when there is none. */
    threads: number | null;
    /** The hour the current state ends, for the progress view to quote. */
    changesAtHour: number | null;
}

/**
 * Settings are read from the row, cached briefly.
 *
 * An admin moving the window expects it to take effect, not to take effect after the next
 * container restart -- and the claim loop asks this twice a second, so reading the row every
 * time would turn a settings lookup into the busiest query in the process.
 */
const CACHE_MS = 30_000;
let cached: { at: number; settings: ThrottleSettings } | null = null;

export const throttleSettings = (): ThrottleSettings => {
    const now = Date.now();

    if (cached && now - cached.at < CACHE_MS) {
        return cached.settings;
    }

    const parsed = throttleSettingsSchema.safeParse(settingRepo.get(SETTING_KEYS.throttle, {}));
    // A malformed row must not stop the worker working. Full speed is the safe direction to
    // fail in: the alternative is a library that quietly stops processing because a setting
    // failed to parse.
    const settings = parsed.success ? parsed.data : DEFAULT_THROTTLE_SETTINGS;

    cached = { at: now, settings };

    return settings;
};

/** How long the pause flag is trusted before it is read again: a kill switch has to be quick. */
const PAUSE_CACHE_MS = 2000;

let pauseCached: { at: number; paused: boolean } | null = null;

/**
 * Whether background processing is paused (§7c "Pausing").
 *
 * Read again every couple of seconds rather than on the throttle's half-minute, because this
 * is the setting somebody changes expecting the box to stop. A malformed row reads as not
 * paused: a library that silently stops processing over a parse error is the worse failure.
 */
export const processingPaused = (): boolean => {
    const now = Date.now();

    if (pauseCached && now - pauseCached.at < PAUSE_CACHE_MS) {
        return pauseCached.paused;
    }

    const parsed = processingPauseSchema.safeParse(settingRepo.get(SETTING_KEYS.pause, {}));
    const paused = parsed.success && parsed.data.paused;

    pauseCached = { at: now, paused };

    return paused;
};

/** Forget the cached settings. For tests, and for a write that must be seen immediately. */
export const forgetThrottleSettings = (): void => {
    cached = null;
};

export const throttleState = (now: Date = new Date()): ThrottleState => {
    const settings = throttleSettings();
    // The configured zone rather than `getHours()`, which reads the container's `TZ` -- UTC
    // on a stock QNAP image, and so a window silently offset by however far its owner lives
    // from Greenwich (§7c).
    const throttled = isThrottled(settings, hourIn(effectiveTimeZone(settings.timeZone), now));

    return {
        throttled,
        // The container's allowance, not the host's: `cpus()` reports four cores under a
        // two-core quota, and half of four is the whole quota.
        threads: throttled ? throttledThreads(settings, effectiveCores()) : null,
        changesAtHour: settings.enabled
            ? throttled
                ? settings.startHour
                : settings.endHour
            : null,
    };
};

/**
 * Whether the work running on this async stack should be polite.
 *
 * `AsyncLocalStorage` rather than a module-level flag, and the difference is not stylistic:
 * several jobs run concurrently and they do not agree. An automatic cover sweep and a cover
 * an admin just asked for can be in flight at the same moment, one throttled and one exempt,
 * and a shared mutable flag would hand whichever spawned second the other's answer.
 *
 * It is read at spawn time rather than passed down through four media-layer signatures. Spawn
 * time is also the more correct moment: a transcode claimed at 07:59 and started at 08:01
 * should run politely, because by then people are using the NAS.
 */
const politeness = new AsyncLocalStorage<boolean>();

export const runWithPoliteness = <T>(polite: boolean, fn: () => T): T => politeness.run(polite, fn);

/** Outside a job -- a startup backfill, a test -- nothing is throttled. */
export const isPolite = (): boolean => politeness.getStore() ?? false;
