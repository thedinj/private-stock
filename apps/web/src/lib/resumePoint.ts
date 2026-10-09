/**
 * Where an item will actually start playing (§8b, §14b).
 *
 * **Nothing is resumed across visits.** Nothing in the library is long enough to be watched in
 * more than one sitting, and storing a position on the server was the most frequent write in the
 * app (§20). What survives is the one case where starting again would feel like a bug: leaving an
 * item for a moment — a tag, a duplicate, Back — and coming straight back to it. So the position
 * is kept in this module, for as long as the page is loaded, and never sent anywhere.
 *
 * The rule is a function, and both callers ask it: the player, deciding where to seek on arrival,
 * and the page, deciding where to warm from. **What is warmed has to be the part that will be
 * played.** `preload="auto"` buffers from the element's `currentTime`, so an item warmed from zero
 * and then resumed at 4:32 arrives with fourteen seconds of the wrong part of the file and stalls
 * exactly as if it had never been warmed.
 */

/**
 * How close to either end stops being a position and starts being noise.
 *
 * Someone five seconds in has not got anywhere worth returning to, and someone five seconds
 * from the end has finished — resuming there would open an item on its credits.
 */
export const RESUME_EDGE_MS = 5_000;

/** Where each item was left, this visit. Numbers keyed by id: a long session costs nothing. */
const visitPositions = new Map<string, number>();

/** Where this item was left earlier in this visit, or null. */
export const visitPosition = (mediaId: string): number | null =>
    visitPositions.get(mediaId) ?? null;

export const rememberPosition = (mediaId: string, positionMs: number): void => {
    visitPositions.set(mediaId, positionMs);
};

/** Played to the end: coming back to it starts again rather than on its last frame. */
export const forgetPosition = (mediaId: string): void => {
    visitPositions.delete(mediaId);
};

/**
 * The position this item opens at, or null for the beginning.
 *
 * Null covers every reason not to move the playhead: nothing recorded, a position inside either
 * edge, or a duration that says the recorded position is effectively the end. Returning null
 * rather than zero is the distinction the warming path needs — "start from the beginning" and
 * "seek to zero" are the same playback and very different instructions to a preloading element.
 */
export const resumeTarget = (
    positionMs: number | null | undefined,
    durationMs: number | null | undefined
): number | null => {
    if (!positionMs || positionMs < RESUME_EDGE_MS) {
        return null;
    }

    if (durationMs && positionMs > durationMs - RESUME_EDGE_MS) {
        return null;
    }

    return positionMs;
};

/**
 * Read `?at=<ms>` off the item page's address: a whole number of milliseconds, or null.
 *
 * `at` rather than `t`, because `t` is the signed media token on the API routes (§12d), and
 * one letter meaning two things in the same app's URLs is a bug report waiting to happen.
 */
export const parseAtParam = (raw: string | null): number | null => {
    if (raw === null || !/^\d+(\.\d+)?$/.test(raw)) {
        return null;
    }

    const value = Math.floor(Number(raw));

    return Number.isFinite(value) ? value : null;
};

/**
 * Where an item opens: an explicit moment when the address names one, else where it was left.
 *
 * The explicit moment is **not** subject to `RESUME_EDGE_MS`. The edges exist to discard noise
 * in a position recorded while somebody watched; a moment somebody chose — the one a capture
 * was taken at, two seconds in — is not noise. It is clamped to the duration when one is
 * known, so an address naming a moment past the end opens on the last frame rather than on a
 * seek the element refuses.
 */
export const openingTarget = (
    startAtMs: number | null | undefined,
    positionMs: number | null | undefined,
    durationMs: number | null | undefined
): number | null => {
    if (startAtMs !== null && startAtMs !== undefined) {
        return durationMs ? Math.min(startAtMs, durationMs) : startAtMs;
    }

    return resumeTarget(positionMs, durationMs);
};
