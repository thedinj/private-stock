"use client";

import { useEffect, useRef } from "react";

import { watchOutPoint, type OutPointSource } from "./outPoint";

/**
 * Ending playback at a span's out point, bound to a React element (§14d).
 *
 * The thinking is in `outPoint.ts`, which is a plain function over a plain object and is where
 * the tests live. This is the four lines of React around it: when to start watching, and when
 * to stop.
 */

export const useOutPoint = (
    video: HTMLVideoElement | null,
    span: { endMs: number; speed: number | null; token?: string | number } | null,
    viewerRate: number,
    onReached: () => void
): void => {
    /**
     * Held in a ref so that changing the handler does not tear down and rebuild the listeners.
     * The effect depends on the span and the element, not on the identity of a closure the caller
     * almost certainly re-creates every render.
     */
    const reached = useRef(onReached);

    reached.current = onReached;

    /**
     * The span's fields rather than the object, so a caller rebuilding it inline every render
     * does not rebind six listeners every render.
     *
     * `token` is which *arrival* this is, and it is what makes asking twice work. Without it the
     * one-shot latch belongs to a binding that never rebuilds: pressing preview again on the clip
     * that has just ended, or a reel holding the same clip twice in a row, would run past the out
     * point because this effect never re-ran.
     */
    const endMs = span?.endMs ?? null;
    const speed = span?.speed ?? null;
    const token = span?.token ?? null;

    useEffect(() => {
        if (!video || endMs === null) {
            return;
        }

        return watchOutPoint(video as unknown as OutPointSource, { endMs, speed }, viewerRate, () =>
            reached.current()
        );
    }, [video, endMs, speed, token, viewerRate]);
};
