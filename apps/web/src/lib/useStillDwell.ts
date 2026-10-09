"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { remainingAfterPause } from "./stageDwell";

/**
 * The clock that ends a thing with no end (§14b).
 *
 * A hook rather than state on the page, for three reasons. It has two listeners and four refs,
 * which is the shape `useIdleControls` and `usePlayerFullscreen` already established belongs
 * behind one. It must be reset by an arrival, and putting that reset on the page beside nine
 * other pieces of state is exactly how `stillFailed` came to survive a step to the next item
 * and claim every later photograph was broken. And the thing that knows the picture is
 * paintable is the `<img>`, so `begin` wants to be a callback the stage holds rather than a
 * prop the page threads down.
 *
 * **The page does not remount between items.** `go()` is a `router.replace` within one dynamic
 * route, so React keeps the instance and only the id changes — the same fact §8b records as
 * "the element now outlives the item". Every latch here therefore keys on `arrivalKey`, and a
 * resolution that belongs to a picture already walked past is dropped rather than allowed to
 * arm a clock.
 *
 * **There is no arm counter, and the first version had one** — to restart the progress line by
 * remounting it. That is right for a new picture and wrong for a resumed one: re-mounting replays
 * the CSS animation from zero, so holding a show at four seconds of five and letting it go made
 * the line jump back to empty and then sweep the remaining second. The line pauses in place
 * instead, on `animation-play-state`, which is both simpler and the only version that tells the
 * truth. The two clocks stay together because they stop and start on the same flag.
 */

export interface StillDwell {
    /** Counting down right now. */
    running: boolean;
    /** Held by the viewer. A hidden tab is not this — see `toggle`. */
    paused: boolean;
    toggle: () => void;
    /** The picture can be painted; start the clock. Safe to call more than once. */
    begin: () => void;
}

export const useStillDwell = (input: {
    /** Which arrival this is. Every latch and timer resets on it. */
    arrivalKey: string;
    /** How long to hold this arrival, or null when no show is running. */
    dwellMs: number | null;
    onEnded: () => void;
    /**
     * Held from outside, as well as by `toggle` (§14g).
     *
     * The tasting has one pause for films and photographs alike, so the hold lives on the stage
     * rather than in here. The clock banks what is left exactly as it does for its own pause.
     */
    held?: boolean;
}): StillDwell => {
    const { arrivalKey, dwellMs, onEnded, held = false } = input;

    const [paused, setPaused] = useState(false);
    const [hidden, setHidden] = useState(false);

    /**
     * The arrival whose picture is showing, rather than a boolean that has to be cleared.
     *
     * A `begun` flag reset by an effect is wrong in the one case that matters most: a picture
     * that was warmed in the other slot is already `complete` when its ref callback runs, and a
     * ref callback runs **before** effects — so `begin()` set the flag and the arrival effect
     * immediately cleared it, and the show stopped dead on every picture it had successfully
     * preloaded. Derived from the key, "begun" cannot outlive its arrival and cannot be undone
     * by something that runs later in the same commit.
     */
    const [begunFor, setBegunFor] = useState<string | null>(null);
    const begun = begunFor === arrivalKey;

    /** What is left of the dwell, carried across a pause. */
    const remainingRef = useRef<number | null>(null);
    /** When the current arm started running, for the arithmetic on the way into a pause. */
    const sinceRef = useRef<number | null>(null);
    /**
     * The callback, off the render path.
     *
     * `onEnded` is a fresh closure every render — it reads `sequence.nextId` — and having it in
     * the effect's dependencies would re-arm the timeout on every render, which for a five
     * second dwell means a show that never advances.
     */
    const endedRef = useRef(onEnded);

    useEffect(() => {
        endedRef.current = onEnded;
    }, [onEnded]);

    /** A new picture: nothing held, and nothing left over from the last one. */
    useEffect(() => {
        setPaused(false);
        remainingRef.current = null;
        sinceRef.current = null;
    }, [arrivalKey]);

    useEffect(() => {
        const onVisibility = (): void => setHidden(document.hidden);

        setHidden(document.hidden);
        document.addEventListener("visibilitychange", onVisibility);

        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    const running = dwellMs !== null && begun && !paused && !hidden && !held;

    useEffect(() => {
        if (dwellMs === null || !begun) {
            return;
        }

        if (!running) {
            // Held, either by the viewer or by the tab going away. Bank what is left so the
            // dwell resumes where it stopped rather than restarting — a show paused at four
            // seconds of five should not give the picture another five.
            if (sinceRef.current !== null) {
                remainingRef.current = remainingAfterPause(
                    remainingRef.current ?? dwellMs,
                    sinceRef.current,
                    Date.now()
                );
                sinceRef.current = null;
            }

            return;
        }

        const hold = remainingRef.current ?? dwellMs;

        sinceRef.current = Date.now();

        const timer = setTimeout(() => {
            remainingRef.current = null;
            sinceRef.current = null;
            endedRef.current();
        }, hold);

        return () => clearTimeout(timer);
    }, [running, dwellMs, begun, arrivalKey]);

    const begin = useCallback(() => setBegunFor(arrivalKey), [arrivalKey]);

    const toggle = useCallback(() => setPaused((value) => !value), []);

    return { running, paused, toggle, begin };
};
