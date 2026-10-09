/**
 * A full garbage collection on a timer (§20 "The worker's own memory").
 *
 * V8 decides when to collect from the size of the JavaScript heap, and in the worker that heap is
 * small and steady (~15-20 MB), so a full collection is rare. But much of what the worker frees
 * is native memory held by small JavaScript objects -- compiled statements did this until they
 * were reused (`reuseStatements` in packages/db), and Node's handles and write requests do it too
 * -- and that memory goes back only when the object is collected. V8 cannot see it, so it does
 * not hurry. Which objects make up the rest was not pinned down; what was measured, in the
 * production image on the production database: after ten minutes, a full collection released
 * 18 MB of the 31 MB of native heap in use, and between collections the worker's resident size
 * climbed ~1.5 MB a minute for most of an hour.
 *
 * The pause is a few milliseconds at this heap size (5-10 ms measured in the image, one outlier
 * of 74 ms), once every five minutes -- nothing beside the multi-second holds §7e is about.
 *
 * It needs `--expose-gc`, which `docker/entrypoint.sh` passes. Without it (a development run)
 * this does nothing, and the worker behaves as it always did.
 */
export const COLLECT_INTERVAL_MS = 5 * 60_000;

/** Run a full collection if this process was started with `--expose-gc`; returns whether it did. */
export const collectGarbage = (): boolean => {
    if (typeof globalThis.gc !== "function") {
        return false;
    }

    globalThis.gc();

    return true;
};
