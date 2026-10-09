import { snapChoice } from "../snapChoice";

/**
 * How long the tasting gives each item (§14g).
 *
 * A closed set, for the reasons the viewer's dwell is one: no stored value can turn the show
 * into a stroboscope or stop it, and the control is one tap on a phone. Longer-leaning than the
 * dwell's 3-15 s, because a video clip needs time to establish what it is -- five seconds of a
 * scene is a glimpse, sixty is a proper taste.
 *
 * Clips and photographs each pick from the same list, separately: the right length for a moving
 * scene is rarely the right one for a still.
 */
export const TASTING_LENGTHS = [5, 10, 20, 30, 60] as const;
export type TastingSeconds = (typeof TASTING_LENGTHS)[number];

/** The lengths as a segmented control's options — the tasting's and the showcase's voice's. */
export const TASTING_LENGTH_DATA = TASTING_LENGTHS.map((seconds) => ({
    value: String(seconds),
    label: `${seconds}s`,
}));

export const DEFAULT_CLIP_SECONDS: TastingSeconds = 10;
export const DEFAULT_PHOTO_SECONDS: TastingSeconds = 5;

export const snapTastingSeconds = (
    value: number | string | null | undefined,
    fallback: TastingSeconds
): TastingSeconds => snapChoice(value, TASTING_LENGTHS, fallback);
