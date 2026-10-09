import { z } from "zod";

import { OCR_SIMILARITY_MIN, foldForComparison, similarity } from "./ocr.js";
import { OCR_PAGE_MODES, ocrSettingsSchema, type OcrSettings } from "./ocrSettings.js";

/**
 * Tuning OCR against expected text (§5d "Tuning against expected text").
 *
 * An administrator nominates videos and types what each should yield; the tuner searches the
 * settings for the best trade between finding that text, adding junk, and frames read. No
 * model is involved: with typed ground truth this is a scored search, and the expensive part —
 * Tesseract — is cached so nearly every candidate is evaluated by replaying cached readings.
 *
 * Everything here is pure: scoring, the grids searched, and choosing what to show. The worker
 * runs the search; the page uses the same scoring to mark a bench comparison's hits and misses.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/** What an administrator says a video should yield. */
export interface ExpectedText {
    expected: string[];
    /**
     * "This is everything legible in it." Then a string nobody expected is junk, in full.
     * Otherwise it might be real text nobody listed, and counts for a quarter as much — not
     * nothing, because a first run against a partly labelled video showed what "nothing" buys:
     * every floor dropped to its minimum and twenty-six fragments like `ag”` read for free.
     */
    complete: boolean;
}

/** A near reading still earns most of the credit, so the search prefers reading it exactly. */
const NEAR_CREDIT = 0.7;

/**
 * Words, folded the way the reconciler compares them.
 *
 * Matching is by word, not by whole string, because Tesseract in sparse mode splits a banner
 * into its words: "DON'T FALL THROUGH!" comes back as three findings. Whole-string matching
 * would score a perfect read of every word as a miss.
 *
 * An expected string with no word of two letters or more is not scored at all.
 */
const words = (text: string): string[] =>
    foldForComparison(text)
        .split(" ")
        // A single letter is the stub folding leaves of an apostrophe — "DON'T" becomes "don"
        // and "t" — and would otherwise weigh as much as a word.
        .filter((word) => word.length > 1);

/** Credit for one expected word against everything read: 1 exact, near credit if similar. */
const wordCredit = (word: string, found: string[]): number => {
    let best = 0;

    for (const candidate of found) {
        if (candidate === word) {
            return 1;
        }

        if (similarity(candidate, word) >= OCR_SIMILARITY_MIN) {
            best = NEAR_CREDIT;
        }
    }

    return best;
};

export interface VideoScore {
    /** Per expected string, the share of its words read (exact 1, near 0.7). */
    hits: { expected: string; coverage: number }[];
    /** Expected strings none of whose words were read. */
    misses: string[];
    /** Strings read that match no expected word. */
    unexpected: string[];
    /** The same, on a video marked complete: what is certainly junk. */
    junk: string[];
    /** Sum of coverage. */
    points: number;
}

export const scoreVideo = (found: string[], truth: ExpectedText): VideoScore => {
    const foundWords = found.flatMap(words);
    const expectedWords = truth.expected.flatMap(words);
    const hits: VideoScore["hits"] = [];
    const misses: string[] = [];
    let points = 0;

    for (const expected of truth.expected) {
        const parts = words(expected);

        if (parts.length === 0) {
            continue;
        }

        const coverage =
            parts.reduce((sum, word) => sum + wordCredit(word, foundWords), 0) / parts.length;

        points += coverage;

        if (coverage > 0) {
            hits.push({ expected, coverage });
        } else {
            misses.push(expected);
        }
    }

    const unexpected = found.filter((text) =>
        words(text).every((word) => wordCredit(word, expectedWords) === 0)
    );

    return { hits, misses, unexpected, junk: truth.complete ? unexpected : [], points };
};

export const tuneCostWeightSchema = z.enum(["low", "medium", "high"]);
export type TuneCostWeight = z.infer<typeof tuneCostWeightSchema>;

/** How much each extra frame (relative to the current settings) costs in score. */
const COST_WEIGHT: Record<TuneCostWeight, number> = { low: 0.05, medium: 0.15, high: 0.3 };

/** Junk is half as bad as a miss is good: finding the watermark matters more than a stray word. */
const JUNK_WEIGHT = 0.5;

/** How much an unexpected string counts on a video not marked complete (see `complete`). */
const PARTIAL_LABEL_WEIGHT = 0.25;

export interface RunTotals {
    recall: number;
    /** Unexpected strings as a share of everything read, weighted by how sure it is junk. */
    junkRate: number;
    /** Frames read relative to the current settings; 1 is the same cost. */
    frameRatio: number;
    score: number;
}

export const totalScore = (
    videos: { score: VideoScore; truth: ExpectedText; foundCount: number; framesRead: number }[],
    baselineFrames: number,
    costWeight: TuneCostWeight
): RunTotals => {
    const expectedCount = videos.reduce(
        (sum, video) => sum + video.truth.expected.filter((text) => words(text).length > 0).length,
        0
    );
    const points = videos.reduce((sum, video) => sum + video.score.points, 0);
    const found = videos.reduce((sum, video) => sum + video.foundCount, 0);
    const noise = videos.reduce(
        (sum, video) =>
            sum + video.score.unexpected.length * (video.truth.complete ? 1 : PARTIAL_LABEL_WEIGHT),
        0
    );
    const frames = videos.reduce((sum, video) => sum + video.framesRead, 0);

    const recall = expectedCount === 0 ? 0 : points / expectedCount;
    const junkRate = found === 0 ? 0 : noise / found;
    const frameRatio = baselineFrames === 0 ? 1 : frames / baselineFrames;

    return {
        recall,
        junkRate,
        frameRatio,
        score: quality({ recall, junkRate }) - COST_WEIGHT[costWeight] * (frameRatio - 1),
    };
};

/** What was read, net of the noise read with it: the score without its cost term. */
const quality = (totals: { recall: number; junkRate: number }): number =>
    totals.recall - JUNK_WEIGHT * totals.junkRate;

// ─────────────────────────────────────────────────────────────────────────────
// What is searched
// ─────────────────────────────────────────────────────────────────────────────

/** The settings that change what Tesseract reads — the only expensive axis to vary. */
export type RecognitionConfig = Pick<OcrSettings, "psm" | "frameWidth" | "contrast">;

export const recognitionKey = (config: RecognitionConfig): string =>
    `psm${config.psm}-w${config.frameWidth}-c${config.contrast ? 1 : 0}`;

const TUNE_WIDTHS = [960, 1280, 1600];

/** Every recognition config "Thorough" tries: 3 modes × contrast on and off × 3 widths. */
export const recognitionGrid = (): RecognitionConfig[] =>
    OCR_PAGE_MODES.flatMap((psm) =>
        [false, true].flatMap((contrast) =>
            TUNE_WIDTHS.map((frameWidth) => ({ psm, contrast, frameWidth }))
        )
    );

/**
 * The axes "Quick" walks one at a time, keeping the best of each before moving to the next
 * (coordinate descent): about seven configs rather than eighteen.
 */
export const recognitionAxes: {
    [K in keyof RecognitionConfig]: RecognitionConfig[K][];
} = {
    psm: [...OCR_PAGE_MODES],
    contrast: [false, true],
    frameWidth: TUNE_WIDTHS,
};

export type Sampling = Pick<
    OcrSettings,
    | "probeFrames"
    | "burstSeconds"
    | "burstEverySeconds"
    | "sweepEverySeconds"
    | "maxFrames"
    | "confirmedOccurrences"
>;

const product = <T extends Record<string, readonly unknown[]>>(
    axes: T
): { [K in keyof T]: T[K][number] }[] =>
    Object.entries(axes).reduce<Record<string, unknown>[]>(
        (combos, [key, values]) =>
            combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value }))),
        [{}]
    ) as { [K in keyof T]: T[K][number] }[];

export const samplingGrid = (): Sampling[] =>
    product({
        probeFrames: [4, 6, 8],
        burstSeconds: [30, 60, 90],
        burstEverySeconds: [1, 2, 3],
        sweepEverySeconds: [60, 120, 180, 300],
        maxFrames: [40, 60, 90],
        confirmedOccurrences: [4, 6, 8],
    });

export type Floors = Pick<OcrSettings, "confidenceMin" | "occurrencesMin" | "minLength">;

export const floorsGrid = (): Floors[] =>
    product({
        confidenceMin: [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
        occurrencesMin: [1, 2, 3, 4],
        minLength: [3, 4, 5, 6],
    });

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

export const tuneModeSchema = z.enum(["quick", "thorough"]);
export type TuneMode = z.infer<typeof tuneModeSchema>;

export const tuneVideoResultSchema = z.object({
    mediaId: z.string(),
    found: z.array(z.string()),
    hits: z.array(z.object({ expected: z.string(), coverage: z.number() })),
    misses: z.array(z.string()),
    // Defaulted: results stored before it existed must still be shown, not silently dropped.
    unexpected: z.array(z.string()).default([]),
    junk: z.array(z.string()),
    framesRead: z.number(),
});
export type TuneVideoResult = z.infer<typeof tuneVideoResultSchema>;

export const tuneCandidateSchema = z.object({
    settings: ocrSettingsSchema,
    recall: z.number(),
    junkRate: z.number(),
    frameRatio: z.number(),
    score: z.number(),
    videos: z.array(tuneVideoResultSchema),
});
export type TuneCandidate = z.infer<typeof tuneCandidateSchema>;

export const tuneResultSchema = z.object({
    /** The current settings, scored the same way, for comparison. */
    baseline: tuneCandidateSchema,
    picks: z.object({
        /** The most expected text read net of noise, whatever it costs. */
        quality: tuneCandidateSchema,
        /** The best score: quality, junk and cost weighed as the run asked. */
        balance: tuneCandidateSchema,
        /** The fewest frames that reads at least as much, as cleanly, as the current settings. */
        cheapest: tuneCandidateSchema.nullable(),
    }),
    evaluated: z.number(),
    /** Frames actually extracted and read by Tesseract in this run; the rest came from cache. */
    framesExtracted: z.number(),
    elapsedMs: z.number(),
});
export type TuneResult = z.infer<typeof tuneResultSchema>;

/**
 * The three candidates worth showing, out of everything evaluated.
 *
 * Three rather than one because the trade is the administrator's to make: the best-scoring
 * candidate already applies the cost weight they chose, but "the most text whatever it costs"
 * and "the same quality for less" are each worth seeing beside it.
 */
export const pickCandidates = (
    candidates: TuneCandidate[],
    baseline: TuneCandidate
): TuneResult["picks"] => {
    const all = [baseline, ...candidates];
    const best = (compare: (a: TuneCandidate, b: TuneCandidate) => number) =>
        [...all].sort(compare)[0];

    /**
     * Ranked net of noise, not by recall alone. By recall alone it was the candidate with every
     * floor at its minimum: the most expected words, under a pile of fragments nobody wants.
     */
    const mostRead = best(
        (a, b) => quality(b) - quality(a) || b.recall - a.recall || a.frameRatio - b.frameRatio
    );
    const balance = best((a, b) => b.score - a.score || a.frameRatio - b.frameRatio);
    const atLeastAsGood = all.filter(
        (candidate) =>
            candidate.recall >= baseline.recall - 1e-9 &&
            candidate.junkRate <= baseline.junkRate + 1e-9 &&
            candidate.frameRatio < baseline.frameRatio - 1e-9
    );
    const cheapest =
        atLeastAsGood.sort((a, b) => a.frameRatio - b.frameRatio || b.recall - a.recall)[0] ?? null;

    return { quality: mostRead, balance, cheapest };
};

// ─────────────────────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────────────────────

export const tuneStartSchema = z.object({
    mode: tuneModeSchema.default("quick"),
    costWeight: tuneCostWeightSchema.default("medium"),
});
export type TuneStartInput = z.infer<typeof tuneStartSchema>;

export const tuneRunStateSchema = z.enum(["pending", "running", "done", "failed", "cancelled"]);
export type TuneRunState = z.infer<typeof tuneRunStateSchema>;

export const tuneRunSchema = z.object({
    id: z.string(),
    state: tuneRunStateSchema,
    mode: tuneModeSchema,
    costWeight: tuneCostWeightSchema,
    /** What it is doing now, in words, for the progress line. */
    stage: z.string().nullable(),
    progress: z.number(),
    result: tuneResultSchema.nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
});
export type TuneRun = z.infer<typeof tuneRunSchema>;

/** What a run would cost before it is started, so nobody starts an afternoon of CPU unawares. */
export const tuneEstimateSchema = z.object({
    /** Nominated videos with expected text; only these can be tuned against. */
    videos: z.number(),
    /** Frames Tesseract would have to read that the cache does not already hold. */
    framesToRead: z.number(),
    /** At the measured rate when there is one, otherwise a conservative guess. */
    minutes: z.number(),
});
export type TuneEstimate = z.infer<typeof tuneEstimateSchema>;

/**
 * The latest run, for the panel's progress and results. Polled while a run is going, so it
 * carries nothing costly to work out — the estimate is a separate request.
 */
export const tuneViewSchema = z.object({
    latest: tuneRunSchema.nullable(),
});
export type TuneView = z.infer<typeof tuneViewSchema>;

export const tuneEstimatesSchema = z.object({
    quick: tuneEstimateSchema,
    thorough: tuneEstimateSchema,
});
export type TuneEstimates = z.infer<typeof tuneEstimatesSchema>;
