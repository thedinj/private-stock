import type { MediaListItem } from "@private-stock/core";

/**
 * Which tile on the showcase wall plays with sound (§14f, "A voice in the wall").
 *
 * Pure and here rather than in the stage, for the reason `tasting/segment.ts` is: it is
 * arithmetic, and arithmetic folded into a component is arithmetic nothing tests. `random` is a
 * parameter so a test can pin the draw.
 */

/** A tile on screen, in screen pixels: what the loop knows about it this frame. */
export interface VoiceCandidate {
    /** The tile's key on the wall — its row and its item — not the item: a set can repeat. */
    key: string;
    item: MediaListItem;
    top: number;
    height: number;
}

/** The band a voice is picked to stay inside, as fractions of the screen's height. */
const BAND_TOP = 0.2;
const BAND_BOTTOM = 0.8;

/**
 * Where a voice is given up for having drifted out of the middle.
 *
 * Looser than the band it was picked in, so that a tile picked near an edge is not cut the
 * moment it is chosen and a tile on the line does not flap between the two.
 */
const LEAVE_TOP = 0.12;
const LEAVE_BOTTOM = 0.88;

/**
 * The least time a tile must have in the band once it starts, or the whole clip if shorter.
 *
 * Without a floor, a tile with any overlap at all was eligible when nothing could see a clip
 * through — so a tile about to leave the top was picked and drifted off as it began. With rows
 * a little shorter than the band, there is always a tile with this much time left at the drift.
 */
const MIN_RUN_MS = 6_000;

export interface PickVoiceOptions {
    /** The screen's height. */
    viewport: number;
    /** How fast the wall is carrying tiles upwards, in px/s. Negative carries them down. */
    driftPxPerS: number;
    /** How long until the picked tile would start playing. */
    leadMs: number;
    clipMs: number;
    /** Tile keys and item ids that may not be picked. */
    exclude: ReadonlySet<string>;
    random?: () => number;
}

/** A film the browser can play straight from the list row, and nothing else (§14g). */
const voiceable = (item: MediaListItem): boolean => item.kind === "video" && item.directPlay;

/**
 * A tile to play next: random, but leaning towards the middle of the screen.
 *
 * Each candidate's centre is carried along at the current drift to where it would start playing,
 * which must be inside the band, and then on until it would leave it: it is eligible only with
 * `MIN_RUN_MS` (or the whole clip) still to go. Tiles that would stay in the band for the whole
 * clip are preferred to tiles that would leave it part way — while drifting, those are the ones
 * low in the band, where rows arrive from — and among them the draw is weighted by how close
 * the middle of the path is to the middle of the screen.
 */
export const pickVoice = (
    candidates: readonly VoiceCandidate[],
    { viewport, driftPxPerS, leadMs, clipMs, exclude, random = Math.random }: PickVoiceOptions
): VoiceCandidate | null => {
    if (viewport <= 0) return null;

    const bandTop = viewport * BAND_TOP;
    const bandBottom = viewport * BAND_BOTTOM;
    const scored: { candidate: VoiceCandidate; inside: number; weight: number }[] = [];

    for (const candidate of candidates) {
        if (
            !voiceable(candidate.item) ||
            exclude.has(candidate.key) ||
            exclude.has(candidate.item.id)
        ) {
            continue;
        }

        const centre = candidate.top + candidate.height / 2;
        const start = centre - (driftPxPerS * leadMs) / 1_000;
        const end = centre - (driftPxPerS * (leadMs + clipMs)) / 1_000;

        if (start < bandTop || start > bandBottom) continue;

        // How long from its start until it crosses the edge it is drifting towards.
        const speed = Math.abs(driftPxPerS);
        const runMs =
            speed < 1
                ? clipMs
                : Math.min(
                      clipMs,
                      ((driftPxPerS > 0 ? start - bandTop : bandBottom - start) / speed) * 1_000
                  );

        if (runMs < Math.min(clipMs, MIN_RUN_MS)) continue;

        const inside = clipMs > 0 ? runMs / clipMs : 1;

        const middle = (start + end) / 2;
        const closeness = Math.max(0, 1 - Math.abs(middle - viewport / 2) / (viewport / 2));

        scored.push({ candidate, inside, weight: inside ** 4 * (0.25 + closeness) });
    }

    if (scored.length === 0) return null;

    // A tile that sees its whole clip through beats any that would be cut short.
    const whole = scored.filter((entry) => entry.inside >= 0.999);
    const pool = whole.length > 0 ? whole : scored;
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let draw = random() * total;

    for (const entry of pool) {
        draw -= entry.weight;

        if (draw < 0) return entry.candidate;
    }

    return pool[pool.length - 1].candidate;
};

/** Whether a playing tile has drifted far enough out of the middle to hand its voice on. */
export const voiceLeaving = (top: number, height: number, viewport: number): boolean => {
    const centre = top + height / 2;

    return centre < viewport * LEAVE_TOP || centre > viewport * LEAVE_BOTTOM;
};
