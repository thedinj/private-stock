import { z } from "zod";

import {
    OCR_BURST_EVERY_MS,
    OCR_BURST_WINDOW_MS,
    OCR_CONFIDENCE_MIN,
    OCR_CONFIRMED_OCCURRENCES,
    OCR_MAX_FRAMES,
    OCR_MIN_LENGTH,
    OCR_OCCURRENCES_MIN,
    OCR_PROBE_FRAMES,
    OCR_SWEEP_EVERY_MS,
} from "./ocr.js";

/**
 * How OCR reads, as an administrator can set it (§5d "Settings and the test bench").
 *
 * Every default is a constant in `ocr.ts` or a literal below, and they are the values the
 * production library was calibrated to on its test bench on 2026-10-02 (revision 1 there). A
 * library where nobody has saved settings reads with these; one that was reading before they
 * changed has outcomes recorded as revision 0 that were read with the earlier values (§5d).
 *
 * Three groups, because they trade three different things:
 *
 *  - **Storage floors** decide how much of what was read is kept. Cheap to change, and the
 *    first thing to reach for when the review queue is mostly junk.
 *  - **Sampling** decides how many frames are read, and where. CPU against the chance of
 *    catching text.
 *  - **Recognition** decides how each frame is read. The biggest lever on watermark quality.
 */

/**
 * Tesseract's page segmentation modes worth offering for text scattered over a picture.
 *
 * 11 (sparse text) finds text wherever it is, which is what a watermark in a corner or a name
 * card over a shot actually is. 12 is the same with orientation detection. 6 assumes one
 * uniform block. Measured when the feature was built, at 1280 wide without the contrast
 * stretch, 6 was worse and 12 comparable -- but the production calibration chose 6 together
 * with 1600 wide and the stretch, and that combination is the default now. The other modes
 * assume a page of prose and find nothing in a video frame.
 */
export const OCR_PAGE_MODES = [6, 11, 12] as const;

const int = (min: number, max: number, fallback: number) =>
    z.coerce.number().int().min(min).max(max).default(fallback);

export const ocrSettingsSchema = z.object({
    // ─── Storage floors ───
    /** A finding below this elected confidence is not stored. */
    confidenceMin: z.coerce.number().min(0).max(1).default(OCR_CONFIDENCE_MIN),
    /** A finding seen in fewer frames than this is not stored. */
    occurrencesMin: int(1, 30, OCR_OCCURRENCES_MIN),
    /** A shorter string is not stored: two letters are noise far more often than words. */
    minLength: int(1, 20, OCR_MIN_LENGTH),

    // ─── Sampling ───
    /** Frames in the cheap first pass that decides whether an item has text at all. */
    probeFrames: int(2, 30, OCR_PROBE_FRAMES),
    /** How much of the opening is read densely, where title and name cards are. */
    burstSeconds: int(0, 600, OCR_BURST_WINDOW_MS / 1000),
    burstEverySeconds: int(1, 60, OCR_BURST_EVERY_MS / 1000),
    /** How often the rest is sampled, looking for a watermark that persists. */
    sweepEverySeconds: int(10, 3600, OCR_SWEEP_EVERY_MS / 1000),
    /** The most frames read from one item, whatever its length. */
    maxFrames: int(6, 300, OCR_MAX_FRAMES),
    /** Frames a string must be seen in before the sweep stops looking. */
    confirmedOccurrences: int(2, 60, OCR_CONFIRMED_OCCURRENCES),

    // ─── Recognition ───
    psm: z.coerce
        .number()
        .refine((value) => (OCR_PAGE_MODES as readonly number[]).includes(value), {
            message: "Choose one of the offered modes",
        })
        .default(6),
    /**
     * Frames are scaled to this width before reading. Tesseract slows with resolution and
     * gains nothing on large text, while narrower starts to thin a small watermark out of
     * legibility. The first calibration measured at 1280; production settled on 1600.
     */
    frameWidth: int(640, 3840, 1600),
    /**
     * A stronger contrast stretch and sharpen before reading, for faint watermarks. Opt-in
     * when it was added; on by default since the production calibration turned it on.
     */
    contrast: z.boolean().default(true),
});
export type OcrSettings = z.infer<typeof ocrSettingsSchema>;

/**
 * What is stored: the settings, and a revision the server increments on every save.
 *
 * The revision is what each OCR outcome records as its recipe (§7b `MediaStage.recipe`), so
 * the library can say which items were read under settings that have since changed. It is
 * never taken from a request.
 */
export const ocrSettingsRecordSchema = ocrSettingsSchema.extend({
    revision: z.coerce.number().int().min(0).default(0),
});
export type OcrSettingsRecord = z.infer<typeof ocrSettingsRecordSchema>;

/** The settings alone, without the revision the server keeps beside them. */
export const ocrSettingsOf = ({
    revision: _revision,
    ...settings
}: OcrSettingsRecord): OcrSettings => settings;

/** The recipe an OCR outcome records: which revision of the settings produced it. */
export const ocrRecipe = (record: Pick<OcrSettingsRecord, "revision">): string =>
    `settings-${record.revision}`;

/**
 * What an outcome with no recorded recipe was produced by.
 *
 * Recipes began with the settings, and every outcome before them was read with the constants
 * the settings now default to — revision 0, exactly. Counting those as "older" would mark a
 * whole library as out of date on the day settings arrived, with nothing having changed.
 */
export const OCR_RECIPE_UNRECORDED = ocrRecipe({ revision: 0 });

/** The settings page's view: the settings, and how much of the library predates them. */
export const ocrSettingsViewSchema = z.object({
    settings: ocrSettingsRecordSchema,
    defaults: ocrSettingsSchema,
    /** Items whose OCR outcome was produced under an older revision. */
    staleItems: z.number(),
    /** Of those, items carrying reviewed findings, which a re-read will leave alone. */
    staleReviewed: z.number(),
});
export type OcrSettingsView = z.infer<typeof ocrSettingsViewSchema>;

/** Queue a batch of items read under older settings to be read again, after `after`. */
export const ocrRerunOutdatedSchema = z.object({
    after: z.string().min(1).max(64).nullable().default(null),
    limit: z.number().int().min(1).max(500).default(200),
});
export type OcrRerunOutdatedInput = z.infer<typeof ocrRerunOutdatedSchema>;

export const ocrRerunOutdatedResultSchema = z.object({
    queued: z.number(),
    /** Where the next batch continues, or null when this was the last. */
    next: z.string().nullable(),
});
export type OcrRerunOutdatedResult = z.infer<typeof ocrRerunOutdatedResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The test bench (§5d "Settings and the test bench")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Videos a comparison runs on. A handful is the point: every one is read twice, in full, at
 * the front of the queue, and the comparison is read by eye.
 */
export const OCR_TEST_SET_LIMIT = 20;

/** One nominated video, and the text an administrator says it should yield (§5d tuning). */
export const ocrTestEntrySchema = z.object({
    mediaId: z.string().min(1).max(64),
    expected: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    /** "This is everything legible in it": only then is unexpected text counted as junk. */
    complete: z.boolean().default(false),
});
export type OcrTestEntry = z.infer<typeof ocrTestEntrySchema>;

/**
 * The stored bench. It began as a list of ids, before expected text existed; a stored list in
 * that shape is read as entries with nothing expected, so nominations survive the change.
 */
export const ocrTestSetSchema = z
    .array(
        z.union([
            z
                .string()
                .min(1)
                .max(64)
                .transform((mediaId): OcrTestEntry => ({ mediaId, expected: [], complete: false })),
            ocrTestEntrySchema,
        ])
    )
    .max(OCR_TEST_SET_LIMIT);

export const ocrExpectedInputSchema = z.object({
    mediaId: z.string().min(1).max(64),
    expected: z.array(z.string().trim().min(1).max(200)).max(50),
    complete: z.boolean(),
});
export type OcrExpectedInput = z.infer<typeof ocrExpectedInputSchema>;

export const ocrTestSetInputSchema = z.object({
    mediaIds: z.array(z.string().min(1).max(64)).max(OCR_TEST_SET_LIMIT),
});
export type OcrTestSetInput = z.infer<typeof ocrTestSetInputSchema>;

export const ocrTestSetAddSchema = z.object({
    mediaIds: z.array(z.string().min(1).max(64)).min(1).max(OCR_TEST_SET_LIMIT),
});
export type OcrTestSetAddInput = z.infer<typeof ocrTestSetAddSchema>;

export const ocrTrialRunSchema = z.object({
    candidate: ocrSettingsSchema,
});
export type OcrTrialRunInput = z.infer<typeof ocrTrialRunSchema>;

/** One string a trial read, as it would have been stored. */
export const ocrTrialFindingSchema = z.object({
    text: z.string(),
    textNorm: z.string(),
    confidence: z.number(),
    occurrences: z.number(),
    stability: z.number(),
    firstAtMs: z.number().nullable(),
});
export type OcrTrialFinding = z.infer<typeof ocrTrialFindingSchema>;

export const ocrTrialStateSchema = z.enum(["pending", "running", "done", "failed"]);
export type OcrTrialState = z.infer<typeof ocrTrialStateSchema>;

/** One side of a comparison: what one set of settings read from one video, and its cost. */
export const ocrTrialSideSchema = z.object({
    state: ocrTrialStateSchema,
    settings: ocrSettingsSchema,
    findings: z.array(ocrTrialFindingSchema),
    framesRead: z.number().nullable(),
    elapsedMs: z.number().nullable(),
    error: z.string().nullable(),
});
export type OcrTrialSide = z.infer<typeof ocrTrialSideSchema>;

export const ocrBenchItemSchema = z.object({
    mediaId: z.string(),
    kind: z.enum(["image", "video"]),
    fileName: z.string(),
    title: z.string(),
    coverUrl: z.string().nullable(),
    expected: z.array(z.string()),
    complete: z.boolean(),
    current: ocrTrialSideSchema.nullable(),
    candidate: ocrTrialSideSchema.nullable(),
});
export type OcrBenchItem = z.infer<typeof ocrBenchItemSchema>;

export const ocrBenchSchema = z.object({
    items: z.array(ocrBenchItemSchema),
    limit: z.number(),
});
export type OcrBench = z.infer<typeof ocrBenchSchema>;
