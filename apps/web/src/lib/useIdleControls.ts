"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Controls that get out of the way, and come back when you ask (§14).
 *
 * On a full screen the picture is the whole point and a bar across the bottom of it is a
 * permanent caption on a film. Every player people already know — YouTube, Plex, VLC, the
 * browser's own — shows the bar on arrival, drops it once nothing has happened for a couple of
 * seconds, and brings it back on the first sign of a viewer. This is that rule.
 *
 * Only on a full screen: in the page the bar is *below* the picture rather than over it, it
 * hides nothing, and a bar that came and went as the pointer crossed the page would be a
 * flicker rather than a courtesy.
 *
 * `hold` is what the caller knows and this does not — the video is paused, a scrub is in
 * progress, the pointer is resting on the bar, the speed menu is open. It is read at the moment
 * the bar would go, so holding it open is never a race with the timer.
 */

/**
 * How long the bar stays after the last sign of life.
 *
 * Plex and YouTube both use three seconds; here it is shorter, because the bar is nearly always
 * dismissed rather than used — it comes back on the first pointer move, so leaving early costs a
 * flick of the wrist, while staying late costs a strip of the picture every time.
 */
const IDLE_MS = 1_800;

/**
 * How long the bar stays after a touch.
 *
 * Longer, because on a touch screen the bar cannot come back on the way to a tap: there is no
 * pointer to move, so the first tap is what brings it, and a tap while it is hidden does nothing
 * else (`useWakingTap`). The bar showing is the cue that the next tap will act -- and 1.8s is
 * less than it takes to look, decide and reach, so the next tap would only bring it back again.
 */
const TOUCH_IDLE_MS = 4_000;

/** Whether a sign of life came from a finger (or a pen) rather than a mouse or a key. */
const isTouch = (event: Event): boolean =>
    event.type === "touchstart" ||
    (typeof PointerEvent !== "undefined" &&
        event instanceof PointerEvent &&
        event.pointerType !== "mouse");

/**
 * `idleMs` is for a caller whose quiet means something else: the showcase starts drifting on
 * it (§14f), and a wall that moves the moment you stop to look at it is not letting you look.
 */
export const useIdleControls = (
    active: boolean,
    hold: () => boolean,
    idleMs: number = IDLE_MS
): boolean => {
    const [idle, setIdle] = useState(false);

    /**
     * Read at the moment of hiding rather than closed over, so that a caller rebuilding this
     * predicate every render — which it will, it reads state — does not tear down and rebind
     * five document listeners every render.
     */
    const holdRef = useRef(hold);
    holdRef.current = hold;

    useEffect(() => {
        if (!active) {
            setIdle(false);

            return;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        /** The wait for the current stretch of quiet: longer when it began with a touch. */
        let delay = idleMs;

        const arm = () => {
            clearTimeout(timer);

            timer = setTimeout(() => {
                // Something still wants the bar. Ask again rather than never again: the
                // pointer will leave, the video will play, the menu will close.
                if (holdRef.current()) {
                    arm();

                    return;
                }

                setIdle(true);
            }, delay);
        };

        const wake = (event: Event) => {
            delay = isTouch(event) ? Math.max(idleMs, TOUCH_IDLE_MS) : idleMs;
            setIdle(false);
            arm();
        };

        /**
         * Bound to the document rather than the container, because on a full screen the
         * container *is* the screen — and a `pointermove` that lands on the control bar or on
         * an open menu is as much a sign of a viewer as one that lands on the picture.
         */
        const events = ["pointermove", "pointerdown", "keydown", "touchstart", "wheel"] as const;

        events.forEach((event) => document.addEventListener(event, wake, { passive: true }));

        arm();

        return () => {
            clearTimeout(timer);
            events.forEach((event) => document.removeEventListener(event, wake));
        };
    }, [active, idleMs]);

    return idle;
};
