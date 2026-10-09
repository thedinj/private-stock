import type { ProcessingStatus } from "./schemas/media.js";
import { STAGES, type StageDefinition, type StageState } from "./stages.js";

/**
 * How far the library has been processed (§13c).
 *
 * The arithmetic that turns "one row per item per stage" into a bar, kept here — away from
 * SQL and away from React — because it is the part with judgement in it. Every decision below
 * has a way of being subtly, invisibly wrong: a bar that reads 100% while the sweep is still
 * working, or one whose segments do not add up to its own total.
 */

/** One row of `MediaStage`, counted. The shape the repo's GROUP BY produces. */
export interface StageCount {
    stage: string;
    state: StageState;
    version: number;
    count: number;
}

/** How many items each stage could possibly apply to. */
export interface ProcessableCounts {
    image: number;
    video: number;
    /** Of those, the ones the probe has read: the population of a stage with `needsProbe`. */
    probedImage: number;
    probedVideo: number;
}

export interface StageProgress {
    stage: string;
    /** One line explaining what the stage is for, straight from the registry. */
    describe: string;
    /** Items this stage applies to at all. The bar's denominator. */
    applicable: number;
    done: number;
    /** Ran, and there was nothing to produce. Settled, not pending. */
    empty: number;
    /** Not applicable to this item after all. Normally zero; see `applicable` below. */
    skipped: number;
    failed: number;
    /** Never attempted, or attempted under a superseded recipe. */
    remaining: number;
    /**
     * Jobs of this stage waiting or running now. Not a share of the bar: it overlaps the
     * others — a repair queued for an item already done, a first pass for one remaining — but a
     * stage with work queued is not complete, whatever its items' recorded outcomes say.
     */
    queued: number;
}

/**
 * The denominator for one stage.
 *
 * `appliesTo` is enforced by the *selection* query rather than by recording `skipped` for
 * every photograph in the library, so a video-only stage's population is the video count and
 * nothing else. Using the whole library here instead would peg the sprite bar at roughly the
 * share of the library that is video and leave it there looking stuck forever.
 */
const applicableTo = (stage: StageDefinition, counts: ProcessableCounts): number => {
    /**
     * A stage that waits on the probe is measured against what the probe has read, because
     * that is all the sweep will ever offer it. A file nobody can read would otherwise sit in
     * the cover bar as "remaining" forever, while its own failure shows on the probe's bar.
     */
    const image = stage.needsProbe ? counts.probedImage : counts.image;
    const video = stage.needsProbe ? counts.probedVideo : counts.video;

    if (stage.appliesTo === "video") return video;
    if (stage.appliesTo === "image") return image;

    return image + video;
};

/**
 * Whether a recorded outcome still counts, given the registry's current recipe.
 *
 * Bumping a stage's `version` is how a recipe is improved across the library, and the sweep
 * treats anything below it as work to redo. A progress view that ignored the version would
 * show a full bar for the entire time that sweep ran — which is precisely when somebody would
 * be looking at it.
 */
const isCurrent = (row: StageCount, stage: StageDefinition): boolean =>
    row.version >= stage.version;

export const stageProgress = (
    counts: ProcessableCounts,
    rows: StageCount[],
    stages: StageDefinition[] = STAGES,
    /** Waiting and running jobs by kind, from the queue. */
    queued: Readonly<Record<string, number>> = {}
): StageProgress[] =>
    stages.map((stage) => {
        const mine = rows.filter((row) => row.stage === stage.name && isCurrent(row, stage));
        const total = (state: StageState): number =>
            mine.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0);

        const applicable = applicableTo(stage, counts);
        const done = total("done");
        const empty = total("empty");
        const skipped = total("skipped");
        const failed = total("failed");

        return {
            stage: stage.name,
            describe: stage.describe,
            applicable,
            done,
            empty,
            skipped,
            failed,
            /**
             * Clamped, because the two sides come from different places and can briefly
             * disagree. `summary()` leaves out the rows of items no longer listed, but the
             * counts are separate queries taken a moment apart, so recorded can still
             * exceed applicable while files are being trashed — and a negative segment
             * renders as a bar running backwards out of its own box.
             */
            remaining: Math.max(0, applicable - done - empty - skipped - failed),
            queued: queued[stage.name] ?? 0,
        };
    });

/**
 * The rows the processing view will have, before it has any of them.
 *
 * Exported so the admin card can lay out its bars while the first poll is in flight (§13c).
 * The names are static — the registry decides them, not the library — so a placeholder can
 * be the right shape and in the right order rather than a guess that reflows when the data
 * lands.
 *
 * A pipeline test pins this against what `stageProgress` actually composes, so adding a
 * stage cannot leave the placeholder a row short.
 */
export const PROGRESS_STAGE_NAMES: string[] = STAGES.map((stage) => stage.name);

/**
 * Where a scan's progress bar is measured against, or null if there is nothing to measure.
 *
 * A directory walk does not know how many files it will find until it has found them, so
 * there is no honest denominator for a library's first scan — `filesSeen` climbs and nothing
 * says toward what. Rather than invent one, this returns null and the UI shows a counter.
 *
 * A *re*-scan is different: the same root's last completed walk is a good estimate, and gets
 * better every time. It is still an estimate, so the caller must handle overshoot — a library
 * that grew since last time will sail past 100% — by clamping rather than by trusting it.
 */
export const scanDenominator = (
    previousFilesSeen: number | null,
    filesSeen: number
): number | null =>
    previousFilesSeen && previousFilesSeen > 0 ? Math.max(previousFilesSeen, filesSeen) : null;

/**
 * How often the processing view asks while something is happening (§13c).
 *
 * Shared because two sides depend on it: the client polls at this rate, and the server's cache
 * of the answer lives a little less than this while work runs, so a cached answer never hides
 * progress for longer than the poll already does. Change one and the other follows.
 */
export const PROCESSING_POLL_MS = 2_000;

/**
 * Whether the library is doing anything worth watching (§13c).
 *
 * The client keeps polling while this holds and stops when it does not -- an idle library is
 * not asked what it is doing every two seconds all night -- and the server caches an idle answer
 * for longer than a busy one. One rule, so the two cannot disagree about what "busy" means.
 *
 * **Outstanding stage work counts, not just the job queue.** Enabling a stage -- turning on OCR,
 * say -- makes it applicable to every item that was never a candidate before, which moves
 * `remaining` immediately while `queue.pending` stays at zero until the worker gets round to
 * creating jobs. Watching only the queue meant the card went back to sleep having just been told
 * there were four thousand items to transcribe.
 *
 * A dead worker still reads as busy for ever, because `remaining` never falls. The same is true
 * of a queue full of claimed jobs, and it is what the liveness badge is for.
 */
export const processingIsActive = (
    status: Pick<ProcessingStatus, "scan" | "queue" | "stages">
): boolean =>
    status.scan !== null ||
    status.queue.pending > 0 ||
    status.queue.claimed > 0 ||
    status.stages.some((stage) => stage.remaining > 0);
