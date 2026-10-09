/**
 * Keeping long jobs from making the worker look dead (§7e).
 *
 * The worker is single threaded on purpose (§2), so every synchronous millisecond a handler
 * spends is a millisecond in which nothing heartbeats, nothing is claimed and nothing
 * finishes. Past about a second that is not slowness, it is indistinguishable from a hang:
 * the jobs in flight freeze at whatever moment it started, the admin view reports the worker
 * as not running, and there is nothing in the log to say otherwise.
 *
 * Two jobs are whole-library passes over tens of thousands of rows and were exactly that
 * shape -- a duplicate pass held the loop for nine seconds with a fifteen-millisecond ticker
 * firing zero times beside it, and the orphan sweep's row check held it for four.
 */

/**
 * How long a pass may hold the loop before handing it back.
 *
 * Well inside the quarter-second nobody perceives, and far below the fifteen-second
 * heartbeat, so no pass can put a claim at risk however long it takes in total.
 */
export const YIELD_AFTER_MS = 25;

/**
 * Give the event loop a turn if this stretch has run long enough, and report the new mark.
 *
 * Returns the timestamp to pass to the next call rather than closing over mutable state, so a
 * loop that forgets to keep the value simply yields on every iteration -- slower, never
 * wrong.
 *
 * `setImmediate` rather than `setTimeout(0)`: it runs after pending I/O callbacks rather than
 * ahead of them, and pending I/O is the point -- ffmpeg pipes and the heartbeat's write are
 * what is waiting.
 */
export const breathe = async (since: number): Promise<number> => {
    if (Date.now() - since < YIELD_AFTER_MS) {
        return since;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));

    return Date.now();
};
