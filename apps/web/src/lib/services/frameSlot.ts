import { RateLimitError } from "@private-stock/core";

/**
 * Frames being read from originals inside requests at once, across every account (§9).
 *
 * "One frame" bounds the work of a single request, not of many. Without a ceiling, anybody
 * signed in could hold a button down -- or script it -- and put as many ffmpeg processes on the
 * request-serving process as they liked, on a NAS whose CPU is the binding constraint (§17).
 * Two covers a household pausing on frames at the same moment; a third caller is told to try
 * again rather than queued, because a queue here would be requests waiting on sockets.
 *
 * One ceiling for every kind of frame: a capture, a still for the picture dialogue and a tag's
 * picture are the same seek and decode on the same disks.
 */
const MAX_CONCURRENT_FRAMES = 2;
let framesInFlight = 0;

export const inFrameSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (framesInFlight >= MAX_CONCURRENT_FRAMES) {
        throw new RateLimitError("Another frame is still being read. Try again in a moment.", 2);
    }

    framesInFlight += 1;

    try {
        return await work();
    } finally {
        framesInFlight -= 1;
    }
};
