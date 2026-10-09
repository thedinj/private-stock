import { describe, expect, it } from "vitest";

import {
    PROGRESS_STAGE_NAMES,
    scanDenominator,
    stageProgress,
    type StageCount,
} from "./pipeline.js";
import { STAGES, type StageDefinition } from "./stages.js";

/**
 * The progress arithmetic (§13c).
 *
 * Every test here is a way the bar can lie while still rendering perfectly: a full bar during
 * a resweep, a video-only stage measured against the whole library, a segment that runs
 * backwards out of its own box. None of them throw, and none are visible in a screenshot —
 * which is the entire reason this is pure and tested here rather than computed in the view.
 */

const stage = (overrides: Partial<StageDefinition> = {}): StageDefinition => ({
    name: "cover",
    version: 1,
    mode: "automatic",
    appliesTo: "all",
    priority: 70,
    maxAttempts: 3,
    needsProbe: false,
    describe: "The still shown in the grid",
    ...overrides,
});

const count = (overrides: Partial<StageCount> = {}): StageCount => ({
    stage: "cover",
    state: "done",
    version: 1,
    count: 1,
    ...overrides,
});

const counts = (image: number, video: number, probedImage = image, probedVideo = video) => ({
    image,
    video,
    probedImage,
    probedVideo,
});

describe("stageProgress", () => {
    it("measures an all-kinds stage against the whole library", () => {
        const [row] = stageProgress(counts(40, 60), [count({ count: 30 })], [stage()]);

        expect(row).toMatchObject({ applicable: 100, done: 30, remaining: 70 });
    });

    /**
     * The selection query filters by kind rather than writing a `skipped` row for every
     * photograph, so a video-only stage's denominator is the video count alone. Measured
     * against the whole library instead, the sprite bar would stop at the share of the
     * library that is video and sit there looking permanently stuck.
     */
    it("measures a video-only stage against the videos alone", () => {
        const [row] = stageProgress(
            counts(40, 60),
            [count({ stage: "sprite", count: 60 })],
            [stage({ name: "sprite", appliesTo: "video" })]
        );

        expect(row).toMatchObject({ applicable: 60, done: 60, remaining: 0 });
    });

    it("counts every settled outcome, not only success", () => {
        const [row] = stageProgress(
            counts(0, 10),
            [
                count({ state: "done", count: 4 }),
                count({ state: "empty", count: 3 }),
                count({ state: "skipped", count: 1 }),
                count({ state: "failed", count: 2 }),
            ],
            [stage()]
        );

        expect(row).toMatchObject({ done: 4, empty: 3, skipped: 1, failed: 2, remaining: 0 });
    });

    /**
     * The regression this exists for.
     *
     * Bumping a stage's version is how a recipe improves across the library, and the sweep
     * redoes every row below it. Counting those as settled would hold the bar at 100% for the
     * entire duration of the resweep -- exactly when somebody would be watching it.
     */
    it("treats an outcome from a superseded recipe as work still to do", () => {
        const [row] = stageProgress(
            counts(0, 10),
            [count({ version: 1, count: 10 })],
            [stage({ version: 2 })]
        );

        expect(row).toMatchObject({ done: 0, remaining: 10 });
    });

    it("keeps an outcome recorded at a newer version than the registry knows", () => {
        const [row] = stageProgress(
            counts(0, 10),
            [count({ version: 3, count: 10 })],
            [stage({ version: 2 })]
        );

        expect(row).toMatchObject({ done: 10, remaining: 0 });
    });

    /**
     * A `MediaStage` row outlives its item being trashed, and the counts are separate queries
     * taken a moment apart. Unclamped, the difference renders as a bar running backwards out
     * of its own box.
     */
    it("never reports negative remaining when more is recorded than is applicable", () => {
        const [row] = stageProgress(counts(0, 5), [count({ count: 9 })], [stage()]);

        expect(row.remaining).toBe(0);
    });

    it("segments always sum to the total, so the bar fills its box exactly", () => {
        const rows = stageProgress(
            counts(30, 70),
            [count({ state: "done", count: 20 }), count({ state: "failed", count: 5 })],
            [stage()]
        );

        for (const row of rows) {
            expect(row.done + row.empty + row.skipped + row.failed + row.remaining).toBe(
                row.applicable
            );
        }
    });

    it("reports an untouched library as entirely remaining rather than as done", () => {
        const [row] = stageProgress(counts(10, 10), [], [stage()]);

        expect(row).toMatchObject({ applicable: 20, done: 0, remaining: 20 });
    });

    it("ignores counts belonging to another stage", () => {
        const [row] = stageProgress(
            counts(0, 10),
            [count({ stage: "sprite", count: 10 })],
            [stage({ name: "cover" })]
        );

        expect(row.done).toBe(0);
    });

    it("returns a row per registered stage, in registry order", () => {
        const rows = stageProgress(counts(5, 5), [], [stage({ name: "a" }), stage({ name: "b" })]);

        expect(rows.map((row) => row.stage)).toEqual(["a", "b"]);
    });

    it("survives an empty library without dividing by anything", () => {
        const [row] = stageProgress(counts(0, 0), [], [stage()]);

        expect(row).toMatchObject({ applicable: 0, done: 0, remaining: 0 });
    });
});

describe("stages that wait on the probe", () => {
    /**
     * The sweep never offers them an item the probe has not read, so that is their whole
     * population. Measured against every item, a file nobody can read would sit in the cover
     * bar as "remaining" forever.
     */
    it("are measured against what the probe has read", () => {
        const [gated, video, open] = stageProgress(
            counts(40, 60, 30, 50),
            [],
            [
                stage({ name: "cover", needsProbe: true }),
                stage({ name: "sprite", appliesTo: "video", needsProbe: true }),
                stage({ name: "index" }),
            ]
        );

        expect(gated).toMatchObject({ applicable: 80, remaining: 80 });
        expect(video).toMatchObject({ applicable: 50 });
        expect(open).toMatchObject({ applicable: 100 });
    });
});

describe("scanDenominator", () => {
    /**
     * A walk does not know its own total until it finishes, so a library's first scan has no
     * honest denominator at all. Inventing one is the classic lying progress bar.
     */
    it("has no denominator for a library that has never been scanned", () => {
        expect(scanDenominator(null, 1_200)).toBeNull();
    });

    it("ignores a previous run that saw nothing", () => {
        expect(scanDenominator(0, 1_200)).toBeNull();
    });

    it("measures against the last completed walk", () => {
        expect(scanDenominator(4_200, 1_200)).toBe(4_200);
    });

    /**
     * A library that grew since last time would otherwise sail past 100%. Taking the larger
     * of the two keeps the bar honest -- it stops looking like an estimate and starts looking
     * like a floor, which it is.
     */
    it("grows the estimate rather than overflowing it when the library has grown", () => {
        expect(scanDenominator(4_200, 5_000)).toBe(5_000);
    });
});

describe("PROGRESS_STAGE_NAMES", () => {
    /**
     * The admin card lays out its placeholder bars from this list while the first poll is in
     * flight, so it has to be exactly what the endpoint will return -- same rows, same order.
     * Composed in two places by necessity (the service holds the database half), which is
     * what makes it worth pinning: adding a stage would otherwise leave the placeholder a row
     * short and nothing would say so.
     */
    it("is what the status endpoint composes, in the same order", () => {
        expect(stageProgress(counts(0, 0), []).map((row) => row.stage)).toEqual(
            PROGRESS_STAGE_NAMES
        );
    });
});

describe("work queued against a stage", () => {
    const counts = (image: number, video: number) => ({
        image,
        video,
        probedImage: image,
        probedVideo: video,
    });

    it("is reported, whether or not the stage's items all have an outcome", () => {
        const stage = STAGES.find((entry) => entry.name === "sprite")!;
        const [row] = stageProgress(
            counts(0, 3),
            [{ stage: "sprite", state: "done", version: stage.version, count: 3 }],
            [stage],
            { sprite: 2, cover: 9 }
        );

        expect(row).toMatchObject({ remaining: 0, queued: 2 });
    });

    it("is none when nothing is queued", () => {
        const [row] = stageProgress(counts(0, 3), [], [STAGES[0]]);

        expect(row.queued).toBe(0);
    });
});
