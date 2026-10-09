/**
 * How a picture arrives (§14b).
 *
 * A show that always crossfades identically starts to pulse: three hundred photographs through
 * one 420 ms dissolve is a metronome, and a metronome is the thing you notice instead of the
 * pictures. So there are four ways in, and which one a picture uses is decided by its id.
 *
 * **Deterministic, not random.** The same photograph always arrives the same way, so walking a
 * set twice looks stable rather than restless, and the choice is something a test can assert.
 * Random would also mean the same picture arriving differently on a re-walk, which reads as the
 * app being unsure of itself.
 *
 * **One grammar, four parameters.** Every variant is opacity plus at most one settling
 * property, all at the same duration. Four genuinely different animations would be four things
 * to notice; this is one thing with a little weather in it. None of them pans or crops: a
 * photograph's framing is the photographer's, and a full Ken Burns would throw away the edges
 * of every picture in the library to look cinematic.
 *
 * Motion preference is deliberately **not** an input here. The collapse to a hard cut is one
 * `prefers-reduced-motion` block in the stylesheet covering all four at once, so a fifth
 * variant added later cannot forget to honour it.
 */
export type StillTransition = "fade" | "warm" | "drift" | "veil";

const TRANSITIONS: readonly StillTransition[] = ["fade", "warm", "drift", "veil"];

/**
 * Which way this picture arrives.
 *
 * FNV-1a with an avalanche on the way out, and both halves of that were learned from a failing
 * test rather than chosen up front:
 *
 * - **Summed code units, the first attempt, was worse than weak.** A sum over a canonical UUID
 *   is `32·digit + 180` for any id whose digits are all the same, and both terms divide by four,
 *   so every such id picked the same variant. Real ids are random hex and would have spread
 *   acceptably — which is exactly the "works on the inputs we happened to try" a mixing function
 *   must not rest on.
 * - **FNV-1a alone did not fix it, because `% 4` reads the low two bits** and those are the
 *   weakest part of FNV: its multiplier is congruent to 3 mod 4, so the bottom of the word
 *   barely mixes at all. Sixteen ids of one repeated digit still chose one variant between them.
 *
 * So the accumulator is avalanched before it is reduced, which spreads the high bits down into
 * the low ones. Nothing here is a security decision; what it has to be is well spread, and
 * identical across reloads and devices.
 */
export const transitionFor = (mediaId: string): StillTransition => {
    let hash = 0x811c9dc5;

    for (let index = 0; index < mediaId.length; index += 1) {
        hash ^= mediaId.charCodeAt(index);
        // `Math.imul` rather than `*`: the product exceeds 2^53 and would silently lose the low
        // bits that carry the mixing.
        hash = Math.imul(hash, 0x01000193);
    }

    // The standard xorshift-multiply finisher. Three rounds is more than a four-way choice
    // needs, and it is the difference between a hash and a hash that happens to work.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;

    return TRANSITIONS[(hash >>> 0) % TRANSITIONS.length];
};
