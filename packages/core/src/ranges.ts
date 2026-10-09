/**
 * Numeric filters, and the bands people actually ask for (§14e).
 *
 * Every measurable property of a file — how long, how detailed, how big — is filtered the
 * same way: a minimum, a maximum, or both. One shape rather than six, because six spellings
 * of "between" is six chances for one of them to be off by an inclusive bound, and because a
 * single shape means a single control, a single chip, and a single place the URL is parsed.
 *
 * **The presets are the interface; the numbers are the escape hatch.** Nobody knows what
 * bitrate they want. They know "the ones that look bad", and the panel's job is to translate.
 * So each range carries a short list of named bands, chosen to match the question rather than
 * to divide the axis evenly — and the raw bounds stay reachable underneath for the case the
 * bands do not cover.
 *
 * Bands are **half-open**: `min` inclusive, `max` exclusive. That is what makes "720p" and
 * "1080p" adjacent rather than overlapping, and it is stated here because the alternative —
 * inclusive on both ends — puts every boundary value in two bands at once, which shows up as
 * counts that do not add up and an item appearing under two filters that are supposed to be
 * alternatives.
 *
 * **Each set of bands covers its whole axis, and the labels have to say so.** A gap is not a
 * missing feature, it is an item that cannot be found by any option offered — and the way it
 * presents is the worst kind: the filter works, the results look reasonable, and one file is
 * simply unreachable. So the first band is open below, the last is open above, and every label
 * in between is written to make the answer to "where would a 719p file appear?" readable off
 * the chip rather than inferable from the chip next to it.
 *
 * That rules out naming a band after the *examples* inside it. "48–60" for a band that starts
 * at 31 is a label that tells somebody with a 45 fps file to look somewhere else, and there is
 * nowhere else.
 *
 * The one thing no band can cover is an item that has never been probed: it has no height, no
 * duration and no bit rate, so it is in none of them. That is a real hole and it is deliberate
 * — the filters describe measurements, and inventing a "not measured" band would need a
 * predicate the range shape cannot express. The panel says it out loud instead.
 *
 * Units are the URL's, not the column's. `?minDurationSec=60` is a thing somebody can read
 * and edit; `?minDurationMs=60000` is a thing they get wrong. The names carry the unit so the
 * conversion has a visible place to happen (§14).
 */

export interface RangeBand {
    /** Stable id, used in the URL only indirectly — the band writes its bounds, not its name. */
    id: string;
    label: string;
    /** Inclusive. Undefined means unbounded below. */
    min?: number;
    /** Exclusive. Undefined means unbounded above. */
    max?: number;
}

/**
 * How long, in seconds.
 *
 * The boundaries are the ones people describe things with — a clip, a scene, a feature —
 * rather than round numbers. "Over an hour" is the band that gets used, and it is the reason
 * the top band is open-ended instead of stopping somewhere arbitrary.
 */
export const DURATION_BANDS: RangeBand[] = [
    { id: "clip", label: "Under a minute", max: 60 },
    { id: "short", label: "1–5 min", min: 60, max: 300 },
    { id: "medium", label: "5–20 min", min: 300, max: 1_200 },
    { id: "long", label: "20–60 min", min: 1_200, max: 3_600 },
    { id: "feature", label: "Over an hour", min: 3_600 },
];

/**
 * Resolution, measured by the **shorter side**.
 *
 * Not height, which is the obvious choice and wrong for a third of a modern library. "1080p"
 * names a frame of 1920×1080 however it is turned: a phone video shot upright is 1080×1920
 * and is still 1080p, but its *height* is 1920, which would file it under 1440p — a tier it
 * has no pixels to justify. Every portrait video in the library would be promoted one or two
 * bands, and the bands would stop meaning anything.
 *
 * The shorter side is the scanline count in the landscape convention the names come from, so
 * it gives the same answer whichever way the frame is turned, and it keeps the two awkward
 * cases right for free: a 2560×1080 ultrawide is 1080p rather than something near 4K, and a
 * square 1080×1080 crop is 1080p rather than a tier of its own.
 */
/**
 * The tier names carry their pixel range, unlike every other axis here.
 *
 * "SD" and "1080p" are classes rather than measurements, and the class boundaries are exactly
 * what somebody with an 800-pixel file cannot guess: is that 720p or is it 1080p? Minutes and
 * megabytes are self-describing, so their bands are named in plain words; these are not, so
 * they say the numbers.
 *
 * Read as a class, an 800-tall file is 720p — it is above the HD floor and below the Full HD
 * one — and a 719-tall file is SD. Both are the standard readings, and both are now on the
 * chip instead of in somebody's head.
 */
export const RESOLUTION_BANDS: RangeBand[] = [
    { id: "sd", label: "SD (under 720)", max: 720 },
    { id: "hd", label: "720p (720–1079)", min: 720, max: 1_080 },
    { id: "fhd", label: "1080p (1080–1439)", min: 1_080, max: 1_440 },
    { id: "qhd", label: "1440p (1440–2159)", min: 1_440, max: 2_160 },
    { id: "uhd", label: "4K (2160 and up)", min: 2_160 },
];

/** Bit rate, in kbps — the unit every encoder and every bitrate argument is written in. */
export const BITRATE_BANDS: RangeBand[] = [
    { id: "low", label: "Under 1 Mbps", max: 1_000 },
    { id: "modest", label: "1–5 Mbps", min: 1_000, max: 5_000 },
    { id: "good", label: "5–10 Mbps", min: 5_000, max: 10_000 },
    { id: "high", label: "10–20 Mbps", min: 10_000, max: 20_000 },
    { id: "very-high", label: "Over 20 Mbps", min: 20_000 },
];

/**
 * Frame rate.
 *
 * Banded around the standards rather than evenly, because frame rates cluster hard: almost
 * everything is 23.976, 25, 29.97, 30, 50, 59.94 or 60, and a band that split 29.97 from 30
 * would be a filter that missed half of what it was asked for. The bounds sit in the gaps, at
 * 24.5, 31 and 61, so each broadcast rate lands with the round number it is named after.
 *
 * **The labels are the bounds, not the rates.** The third band was called "48–60" because
 * those are the rates that actually occur in it — which told anybody holding a 45 fps file to
 * look somewhere else, and there is nowhere else. Naming a band after its contents rather than
 * its edges is how a set of filters that covers everything still manages to lose a file.
 */
export const FPS_BANDS: RangeBand[] = [
    { id: "cinema", label: "24 and under", max: 24.5 },
    { id: "standard", label: "25–30", min: 24.5, max: 31 },
    { id: "smooth", label: "31–60", min: 31, max: 61 },
    { id: "high", label: "Over 60", min: 61 },
];

/** File size, in megabytes. */
export const SIZE_BANDS: RangeBand[] = [
    { id: "small", label: "Under 100 MB", max: 100 },
    { id: "medium", label: "100 MB – 1 GB", min: 100, max: 1_024 },
    { id: "large", label: "1–5 GB", min: 1_024, max: 5_120 },
    { id: "huge", label: "Over 5 GB", min: 5_120 },
];

/**
 * The band a pair of bounds came from, or null if the bounds are a custom range.
 *
 * Matched on the bounds rather than remembered as a name, because the URL carries the numbers
 * and nothing else. That is deliberate: a band is a shorthand for a range, so a link built
 * from a preset and one typed by hand are the same link, and renaming a band later cannot
 * strand a saved filter that used it.
 */
export const bandFor = (
    bands: RangeBand[],
    min: number | null,
    max: number | null
): RangeBand | null =>
    bands.find((band) => (band.min ?? null) === min && (band.max ?? null) === max) ?? null;

/**
 * A range in words, for the chip that says what is being filtered.
 *
 * Named after its band when it is one, so the chip reads "1080p" rather than
 * "1080–1440" — the chip is there to be recognised at a glance, and the number it was
 * built from is not what anyone chose.
 */
export const describeRange = (
    bands: RangeBand[],
    min: number | null,
    max: number | null,
    unit: string
): string | null => {
    if (min === null && max === null) {
        return null;
    }

    const band = bandFor(bands, min, max);

    if (band) {
        return band.label;
    }

    if (min !== null && max !== null) {
        return `${min}–${max} ${unit}`;
    }

    return min !== null ? `${min} ${unit} and up` : `under ${max} ${unit}`;
};
