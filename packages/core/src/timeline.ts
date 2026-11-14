import { z } from "zod";

import { spanRunMs, speedOf } from "./clips.js";

/**
 * A reel laid out as an editor's timeline (§14d "Editor export").
 *
 * The app thinks in milliseconds and an editor thinks in frames, and every mistake available in
 * between is invisible until somebody looks at a cut in Resolve and finds it one frame late. So
 * the conversion is decided here, pure, where a test can say what each number should be, and the
 * serializer (`fcpxml.ts`) only spells the result.
 *
 * Two clocks are involved and are never mixed: a **source** clock per file (its own frame rate,
 * which is what the in-point snaps to) and the **sequence** clock (the rate chosen at export,
 * which every position and duration on the timeline snaps to).
 */

/** A frame rate as editors write it: 30000/1001, never 29.97. */
export const frameRateSchema = z.object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
});

export type FrameRate = z.infer<typeof frameRateSchema>;

/** The rates an editor offers for a timeline, in the order a picker lists them. */
export const STANDARD_FRAME_RATES: readonly FrameRate[] = [
    { num: 24000, den: 1001 },
    { num: 24, den: 1 },
    { num: 25, den: 1 },
    { num: 30000, den: 1001 },
    { num: 30, den: 1 },
    { num: 50, den: 1 },
    { num: 60000, den: 1001 },
    { num: 60, den: 1 },
];

const frameRateValue = (rate: FrameRate): number => rate.num / rate.den;

/** `"30000/1001"`: the form a rate takes in a URL and as a map key. */
export const frameRateKey = (rate: FrameRate): string => `${rate.num}/${rate.den}`;

/** `"29.97"`, `"25"`: the form a person reads. */
export const formatFrameRate = (rate: FrameRate): string => {
    const value = frameRateValue(rate);

    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "");
};

/** Reads `"30000/1001"` or `"25"`; `null` for anything that is not a positive rate. */
export const parseFrameRateKey = (text: string): FrameRate | null => {
    const match = /^(\d{1,6})(?:\/(\d{1,6}))?$/.exec(text.trim());

    if (!match) return null;

    const num = Number(match[1]);
    const den = match[2] === undefined ? 1 : Number(match[2]);

    return num > 0 && den > 0 ? { num, den } : null;
};

/**
 * The rational behind a rate the probe stored as a rounded decimal.
 *
 * The probe keeps three decimals, so 29.97 is 30000/1001 -- what the camera meant -- to within
 * 0.002%. The tolerance has to stay far below the 0.1% that separates 30 from 29.97 and 60 from
 * 59.94, or a true 60 fps file is read as NTSC and drifts a frame every sixteen seconds. Anything
 * else (a 15 fps screen recording, a 12.5 fps timelapse) keeps its own value to the thousandth,
 * which an editor accepts as a source rate though nobody would cut a timeline at it.
 */
export const snapFrameRate = (fps: number): FrameRate => {
    for (const rate of STANDARD_FRAME_RATES) {
        if (Math.abs(frameRateValue(rate) - fps) / fps < 0.0002) return rate;
    }

    const num = Math.round(fps * 1000);
    const divisor = gcd(num, 1000);

    return { num: num / divisor, den: 1000 / divisor };
};

/** One file a reel draws on, with the facts an editor needs about it. */
export const timelineSourceSchema = z.object({
    mediaId: z.string(),
    /** The file's own name, which is what the editor's media pool calls it. */
    fileName: z.string(),
    /** Where the editing machine finds the file (a UNC or drive-letter path). */
    path: z.string(),
    durationMs: z.number().int().positive().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    /** `null` for a source with no meaningful rate; the sequence's rate stands in. */
    rate: frameRateSchema.nullable(),
    /** SMPTE start timecode (`01:00:00:00`, `;` for drop-frame), when the file carries one. */
    timecode: z.string().nullable(),
    hasAudio: z.boolean(),
    audioChannels: z.number().int().positive().nullable(),
});

export type TimelineSource = z.infer<typeof timelineSourceSchema>;

/** One span in reel order, as the exporter is handed it. */
export const timelineEntrySchema = z.object({
    mediaId: z.string(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    speed: z.number().nullable(),
    label: z.string().nullable(),
    keywords: z.array(z.string()),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/** A span placed on the timeline. Every number is a whole frame on the clock it names. */
export const timelineClipSchema = z.object({
    mediaId: z.string(),
    name: z.string(),
    label: z.string().nullable(),
    keywords: z.array(z.string()),
    /** Where it sits, in sequence frames from the start of the timeline. */
    offsetFrames: z.number().int().nonnegative(),
    /** How long it runs on the timeline, in sequence frames -- after speed. */
    durationFrames: z.number().int().positive(),
    /** The in-point, in source frames from the start of the file (timecode not included). */
    sourceInFrames: z.number().int().nonnegative(),
    /** 1 for a clip at its own speed. */
    speed: z.number().positive(),
});

export type TimelineClip = z.infer<typeof timelineClipSchema>;

export const reelTimelineSchema = z.object({
    name: z.string(),
    description: z.string().nullable(),
    rate: frameRateSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationFrames: z.number().int().nonnegative(),
    clips: z.array(timelineClipSchema),
    /** Only the sources a clip uses, in first-use order. */
    sources: z.array(timelineSourceSchema),
});

export type ReelTimeline = z.infer<typeof reelTimelineSchema>;

/** One source rate and how much of the reel's watching time is at it. */
export const rateShareSchema = z.object({
    rate: frameRateSchema,
    runMs: z.number().int().nonnegative(),
    clipCount: z.number().int().nonnegative(),
});

export type RateShare = z.infer<typeof rateShareSchema>;

/** A timeline of 1080p is what an editor opens to when nothing says otherwise. */
const FALLBACK_SIZE = { width: 1920, height: 1080 };
const FALLBACK_RATE: FrameRate = { num: 30, den: 1 };

/**
 * How the reel's watching time divides between source rates, largest share first.
 *
 * Weighted by run time rather than by clip count: one long 24 fps scene and five quick 60 fps
 * cut-aways is a 24 fps reel, and conforming the long scene would be the visible damage. A
 * source with no rate is counted under no rate at all, since it votes for nothing.
 */
export const rateShares = (entries: TimelineEntry[], sources: TimelineSource[]): RateShare[] => {
    const byId = new Map(sources.map((source) => [source.mediaId, source]));
    const shares = new Map<string, RateShare>();

    for (const entry of entries) {
        const rate = byId.get(entry.mediaId)?.rate;

        if (!rate) continue;

        const key = frameRateKey(rate);
        const share = shares.get(key) ?? { rate, runMs: 0, clipCount: 0 };

        share.runMs += spanRunMs(entry);
        share.clipCount += 1;
        shares.set(key, share);
    }

    return [...shares.values()].sort((a, b) => b.runMs - a.runMs || b.clipCount - a.clipCount);
};

/**
 * The timeline rate to offer first: the standard rate nearest the largest share.
 *
 * A timeline is cut at a standard rate even when the footage is not -- a 15 fps screen
 * recording among phone video does not make the reel a 15 fps reel -- so the largest share is
 * moved onto the nearest standard rate, and an empty reel gets 30.
 *
 * **Rates vote by family.** 30 and 29.97 differ by a tenth of a percent and conforming one to
 * the other is invisible, where 60 to 30 drops every other frame. So a reel that is mostly 30
 * and 29.97 with one long 60 fps clip is a 30-family reel, and within the winning family the
 * member with the most watching time is the one offered.
 */
export const recommendedFrameRate = (shares: RateShare[]): FrameRate => {
    const families = new Map<number, { runMs: number; members: Map<string, RateShare> }>();

    for (const share of shares) {
        const standard = nearestStandardRate(share.rate);
        const familyKey = Math.round(frameRateValue(standard));
        const family = families.get(familyKey) ?? { runMs: 0, members: new Map() };
        const key = frameRateKey(standard);
        const member = family.members.get(key) ?? { rate: standard, runMs: 0, clipCount: 0 };

        member.runMs += share.runMs;
        family.runMs += share.runMs;
        family.members.set(key, member);
        families.set(familyKey, family);
    }

    const best = [...families.values()].sort((a, b) => b.runMs - a.runMs)[0];

    if (!best) return FALLBACK_RATE;

    return [...best.members.values()].sort((a, b) => b.runMs - a.runMs)[0].rate;
};

const nearestStandardRate = (rate: FrameRate): FrameRate => {
    const value = frameRateValue(rate);

    return STANDARD_FRAME_RATES.reduce((best, candidate) =>
        Math.abs(frameRateValue(candidate) - value) < Math.abs(frameRateValue(best) - value)
            ? candidate
            : best
    );
};

export const sameRate = (a: FrameRate, b: FrameRate): boolean => a.num * b.den === b.num * a.den;

/** Milliseconds as whole frames at `rate`, to the nearest frame. */
export const msToFrames = (ms: number, rate: FrameRate): number =>
    Math.round((ms * rate.num) / (rate.den * 1000));

/**
 * A SMPTE timecode as a frame count at `rate`.
 *
 * Drop-frame (`;` before the frames) skips two frame numbers at the top of every minute except
 * each tenth, which is the only way 29.97 frames a second keeps step with a wall clock; reading
 * it as non-drop puts a one-hour timecode 108 frames out. Returns `null` for a malformed value,
 * which the exporter treats as no timecode at all.
 */
export const timecodeToFrames = (timecode: string, rate: FrameRate): number | null => {
    const match = /^(\d{1,2}):(\d{2}):(\d{2})([:;.,])(\d{2})$/.exec(timecode.trim());

    if (!match) return null;

    const [hours, minutes, seconds, frames] = [match[1], match[2], match[3], match[5]].map(Number);
    const nominal = Math.round(frameRateValue(rate));

    if (minutes > 59 || seconds > 59 || frames >= nominal) return null;

    const totalMinutes = hours * 60 + minutes;
    const count = (totalMinutes * 60 + seconds) * nominal + frames;
    const dropFrame = match[4] === ";" || match[4] === ",";

    if (!dropFrame) return count;

    const dropped = Math.round(nominal / 15); // 2 at 29.97, 4 at 59.94

    return count - dropped * (totalMinutes - Math.floor(totalMinutes / 10));
};

/**
 * Lays a reel out as a timeline at `rate`.
 *
 * Entries whose source is missing from `sources` are dropped -- the caller filtered them out for
 * a reason (the viewer cannot reach that library) and the timeline must not reference them.
 *
 * Positions accumulate in whole sequence frames, so each clip's length is rounded once and
 * the cut points never drift: forty clips each rounded on their own millisecond offsets would
 * land up to a frame off by the end, where summing whole frames lands exactly.
 */
export const buildReelTimeline = (input: {
    name: string;
    description: string | null;
    rate: FrameRate;
    entries: TimelineEntry[];
    sources: TimelineSource[];
}): ReelTimeline => {
    const byId = new Map(input.sources.map((source) => [source.mediaId, source]));
    const used = new Map<string, TimelineSource>();
    const clips: TimelineClip[] = [];
    let offsetFrames = 0;

    for (const entry of input.entries) {
        const source = byId.get(entry.mediaId);

        if (!source) continue;

        used.set(source.mediaId, source);

        const durationFrames = Math.max(1, msToFrames(spanRunMs(entry), input.rate));

        clips.push({
            mediaId: entry.mediaId,
            name: entry.label?.trim() || source.fileName,
            label: entry.label?.trim() || null,
            keywords: entry.keywords,
            offsetFrames,
            durationFrames,
            sourceInFrames: msToFrames(entry.startMs, source.rate ?? input.rate),
            speed: speedOf(entry.speed),
        });
        offsetFrames += durationFrames;
    }

    const sources = [...used.values()];

    return {
        name: input.name,
        description: input.description,
        rate: input.rate,
        ...dominantSize(input.entries, sources),
        durationFrames: offsetFrames,
        clips,
        sources,
    };
};

/** The frame size holding the most watching time, so most of the reel is not rescaled. */
const dominantSize = (
    entries: TimelineEntry[],
    sources: TimelineSource[]
): { width: number; height: number } => {
    const byId = new Map(sources.map((source) => [source.mediaId, source]));
    const totals = new Map<string, { width: number; height: number; runMs: number }>();

    for (const entry of entries) {
        const source = byId.get(entry.mediaId);

        if (!source?.width || !source.height) continue;

        const key = `${source.width}x${source.height}`;
        const total = totals.get(key) ?? { width: source.width, height: source.height, runMs: 0 };

        total.runMs += spanRunMs(entry);
        totals.set(key, total);
    }

    const best = [...totals.values()].sort((a, b) => b.runMs - a.runMs)[0];

    return best ? { width: best.width, height: best.height } : FALLBACK_SIZE;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
