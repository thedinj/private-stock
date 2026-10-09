/**
 * Where a long name is cut when it does not fit: in the middle, keeping its end (§14).
 *
 * A library's names share their beginnings and differ at their ends -- `FallGuys client
 * 2026-03-12 21-04-33`, sixty times over, with only the time changing -- so the ordinary end
 * cut keeps exactly the part every one of them has in common. `MiddleEllipsis` keeps the tail
 * whole and lets CSS cut the head; this decides where the tail starts.
 *
 * Pure, so the rule can be tested without a browser, and the same for every name: the cut
 * never depends on what the name happens to be shown beside.
 */

export interface MiddleSplit {
    /** Cut with an ellipsis when space runs out. */
    head: string;
    /** Always shown whole, unless it alone is wider than the space; empty for no split. */
    tail: string;
}

/** Shorter than this, a name nearly always fits, and an end cut of it loses little. */
const MIN_LENGTH = 16;

/** The share of the name the tail aims for, and the bounds it stays inside. */
const TAIL_SHARE = 0.4;
const MIN_TAIL = 6;
const MAX_TAIL = 20;

/**
 * Word starts, strongest first. A space or a dot or underscore separates the parts of a name;
 * a hyphen usually joins the parts of one -- a date, a time -- so it is only used when no
 * stronger boundary lands in range, and `2026-03-12` is kept together rather than cut at `03`.
 */
const BOUNDARIES = [/[\s._]/, /[-+,;:()[\]]/];

export const splitForMiddleEllipsis = (text: string): MiddleSplit => {
    if (text.length < MIN_LENGTH) {
        return { head: text, tail: "" };
    }

    const target = Math.min(MAX_TAIL, Math.max(MIN_TAIL, Math.round(text.length * TAIL_SHARE)));

    for (const boundary of BOUNDARIES) {
        let best: number | null = null;

        // A tail starts at a word start: just after a boundary character, never at index 0.
        for (let start = 1; start < text.length; start++) {
            const tailLength = text.length - start;

            if (tailLength < MIN_TAIL || tailLength > MAX_TAIL) continue;
            if (!boundary.test(text[start - 1]) || boundary.test(text[start])) continue;

            if (
                best === null ||
                Math.abs(tailLength - target) < Math.abs(text.length - best - target)
            ) {
                best = start;
            }
        }

        if (best !== null) {
            return { head: text.slice(0, best), tail: text.slice(best) };
        }
    }

    // No word start in range: a run-on name. Cutting through it would split a number or a word
    // at an arbitrary letter, which reads as corruption; the end cut is the honest fallback.
    return { head: text, tail: "" };
};
