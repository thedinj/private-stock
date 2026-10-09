import { effectiveRate, msUntilOut, reachedOut } from "@private-stock/core";

/**
 * Ending playback at a span's out point (§14d).
 *
 * The wiring, separated from the hook so it can be driven by a plain object. `useOutPoint` is
 * four lines of React around this; everything that can be got wrong is here, and everything
 * here is reachable from a test.
 *
 * `timeupdate` alone overshoots by up to a quarter of a second, because it fires at roughly
 * 4 Hz. That is invisible at the end of a film and very visible at the end of a twelve-second
 * span, because the overshoot lands on the join — the one frame of a cut anybody looks at. At 2×
 * it is half a second of footage nobody asked for.
 *
 * Three layers, each covering what the one above it cannot:
 *
 *  1. **`requestVideoFrameCallback`**, where the browser has it: one call per *presented* frame,
 *     so the out point lands within a frame. Chromium and Safari throughout, Firefox from 130.
 *  2. **A timer** otherwise, armed for the remaining wall clock and re-armed whenever the rate,
 *     the position or the paused state changes.
 *  3. **`timeupdate`** as an unconditional backstop under both. In a background tab no frames are
 *     presented and timers are clamped to the second, so a reel left in the background *will*
 *     overrun — this bounds that at about a second, which is the honest cost and an acceptable
 *     one, because nobody is watching.
 *
 * The frame callback does one float comparison and at most one call out. **No `setState` in it**:
 * at 60 Hz that is a re-render per frame.
 */

/** The part of a media element this needs. An interface so a test can supply a fake. */
export interface OutPointSource {
    currentTime: number;
    playbackRate: number;
    paused: boolean;
    pause: () => void;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    requestVideoFrameCallback?: (callback: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
}

export interface OutPointSpan {
    endMs: number;
    speed: number | null;
}

/** How close to the out point the coarse trigger hands over to an exact timer. */
export const ARM_WITHIN_MS = 400;

/**
 * The events that change the arithmetic a timer was armed with.
 *
 * A seek moves the position, a rate change moves the wall clock, and pausing stops it. Without
 * the re-arm, scrubbing backwards inside a span would end it early.
 *
 * `play` is not here: it is bound separately, because it has to refuse as well as re-arm.
 */
const REARM_EVENTS = ["seeking", "seeked", "ratechange", "pause"] as const;

/**
 * Watches one span and stops at its end. Returns the teardown.
 *
 * **Pauses before calling back**, and that ordering is the fix for two bugs that looked
 * unrelated. Reaching an out point is the end of the span whether or not anything follows it:
 * on an item page, "preview this clip" used to run on into the rest of the film, and in a reel
 * the only thing that stopped the overshoot was the next span's seek. Making the stop the
 * player's job rather than each caller's fixes both. A reel advances immediately afterwards and
 * its arrival starts playback again, so the pause lasts a seek.
 */
export const watchOutPoint = (
    source: OutPointSource,
    span: OutPointSpan,
    viewerRate: number,
    onReached: () => void
): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let done = false;

    const finish = () => {
        if (done) {
            return;
        }

        done = true;
        source.pause();
        onReached();
    };

    const check = (): boolean => {
        if (reachedOut(source.currentTime * 1000, span.endMs)) {
            finish();

            return true;
        }

        return false;
    };

    /**
     * A span that has ended does not start again by itself.
     *
     * Without this, pressing play after the last clip of a reel resumed the underlying file at the
     * out point and ran on through the rest of it — the span's end had already fired, so the latch
     * below was set and nothing was left watching. Whether *anything* should follow a finished
     * span is the caller's decision (`onReplay`); that it must not silently keep playing the
     * source is this one's.
     */
    const onPlay = () => {
        if (done) {
            source.pause();

            return;
        }

        arm();
    };

    const arm = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }

        if (done || source.paused) {
            return;
        }

        const rate = effectiveRate(span.speed, source.playbackRate || viewerRate);
        const remaining = msUntilOut(source.currentTime * 1000, span.endMs, rate);

        if (remaining <= ARM_WITHIN_MS) {
            timer = setTimeout(finish, remaining);
        }
    };

    const onTimeUpdate = () => {
        if (!check()) {
            arm();
        }
    };

    source.addEventListener("timeupdate", onTimeUpdate);
    source.addEventListener("play", onPlay);
    REARM_EVENTS.forEach((event) => source.addEventListener(event, arm));

    if (typeof source.requestVideoFrameCallback === "function") {
        const tick = () => {
            if (done) {
                return;
            }

            if (!check()) {
                frame = source.requestVideoFrameCallback?.(tick);
            }
        };

        frame = source.requestVideoFrameCallback(tick);
    }

    arm();

    return () => {
        source.removeEventListener("timeupdate", onTimeUpdate);
        source.removeEventListener("play", onPlay);
        REARM_EVENTS.forEach((event) => source.removeEventListener(event, arm));

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        if (frame !== undefined) {
            source.cancelVideoFrameCallback?.(frame);
        }
    };
};
