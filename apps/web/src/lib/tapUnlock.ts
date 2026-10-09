/**
 * Seven quick taps on the build line open the admin tools (the About dialog).
 *
 * The phone's developer-options gesture, chosen because it is the one people already know for
 * "a door that is there but not signposted". Pure, so the counting is testable.
 */

export const TAPS_TO_UNLOCK = 7;

/** A pause longer than this starts the count again. */
export const TAP_GAP_MS = 1_000;

/**
 * The run of taps that ends with this one: everything kept from `previous` that is still part of
 * an unbroken run, plus `now`.
 */
export const recordTap = (previous: readonly number[], now: number): number[] => {
    const last = previous.at(-1);
    const run = last !== undefined && now - last <= TAP_GAP_MS ? [...previous, now] : [now];

    return run.slice(-TAPS_TO_UNLOCK);
};

/** How many more taps the run needs; zero means open. */
export const tapsRemaining = (run: readonly number[]): number =>
    Math.max(0, TAPS_TO_UNLOCK - run.length);
