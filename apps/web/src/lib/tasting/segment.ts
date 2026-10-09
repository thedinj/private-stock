import { MOMENT_LEAD_MS } from "@/lib/lookMoment";

/**
 * Which part of a film the tasting plays (§14g).
 *
 * A random segment of the clip length, from inside a window that leaves out the first and last
 * twentieth of the file. The ends are where the least representative seconds live -- a black
 * lead-in, a title card, credits, the camera being put down -- and a taste that lands on them
 * says nothing about the rest.
 *
 * Pure and here rather than in the stage, for the reason `viewerSequence.ts` is: it is
 * arithmetic, and arithmetic folded into a component is arithmetic nothing tests. `random` is a
 * parameter so a test can pin both ends of the range.
 */

export interface Segment {
    startMs: number;
    endMs: number;
}

/** The fraction trimmed from each end before a start is chosen. */
const TRIM = 0.05;

export const pickSegment = (
    durationMs: number | null,
    clipMs: number,
    random: () => number = Math.random
): Segment => {
    // Not probed yet, or probed as nothing: the only position known to exist is the start. The
    // out point may lie past the end, which is why the stage also listens for `ended`.
    if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return { startMs: 0, endMs: Math.round(clipMs) };
    }

    // Shorter than a taste: the whole of it.
    if (durationMs <= clipMs) {
        return { startMs: 0, endMs: Math.round(durationMs) };
    }

    const lo = durationMs * TRIM;
    const hi = durationMs * (1 - TRIM) - clipMs;

    // The window is too narrow for a whole taste inside it: start at its beginning and let the
    // taste run into the trimmed tail rather than cutting it short.
    if (hi < lo) {
        const startMs = Math.round(lo);

        return { startMs, endMs: Math.round(Math.min(durationMs, lo + clipMs)) };
    }

    const startMs = Math.round(lo + random() * (hi - lo));

    return { startMs, endMs: startMs + Math.round(clipMs) };
};

/**
 * The segment that starts at a look's matching moment (§5e "Three ways in, one way out").
 *
 * "Glasses" should open on the glasses, so a taste of a look's set starts just before where each
 * item matched rather than at a random point. Pulled back to fit when the match is too near the
 * end for a whole taste, and the whole of anything shorter than one.
 */
export const segmentAt = (durationMs: number | null, clipMs: number, atMs: number): Segment => {
    const known = durationMs !== null && Number.isFinite(durationMs) && durationMs > 0;

    if (known && durationMs <= clipMs) {
        return { startMs: 0, endMs: Math.round(durationMs) };
    }

    // A second before the match, as the tile and the viewer open it.
    const latest = known ? durationMs - clipMs : Infinity;
    const startMs = Math.round(Math.max(0, Math.min(atMs - MOMENT_LEAD_MS, latest)));

    return { startMs, endMs: startMs + Math.round(clipMs) };
};

/** How far through its segment a playhead is, from 0 to 1. */
export const segmentProgress = (positionMs: number, segment: Segment): number => {
    const length = segment.endMs - segment.startMs;

    if (length <= 0) {
        return 1;
    }

    return Math.min(1, Math.max(0, (positionMs - segment.startMs) / length));
};
