"use client";

import { useCallback, useRef } from "react";

/**
 * A tap that only brings the controls back (§14f, §14g).
 *
 * On a full-screen mode with idle controls, a mouse announces itself before it clicks: moving it
 * brings the controls back on the way. A finger cannot -- the tap is the first thing the screen
 * hears, and it lands on whatever is under it. On the showcase that was a tile, so reaching for
 * the controls opened an item; on the tasting it paused the show.
 *
 * So the rule, the same on both: **on a touch screen, a tap while the controls are hidden only
 * brings them back.** Once they are showing, taps act -- open the tile, pause the show. The
 * controls being up is the visible cue for which kind of tap the next one will be, and after a
 * touch they stay up long enough to make it (`useIdleControls`).
 *
 * A mouse is never swallowed: by the time it clicks it has moved, so the controls were already
 * up; and a click after the pointer has sat still is a deliberate one.
 *
 * `idle` is read when the finger goes down, before the document's own listener has brought the
 * controls back -- which is what makes it the state the tap was aimed at.
 */
export const useWakingTap = (idle: boolean) => {
    const idleRef = useRef(idle);
    const woke = useRef(false);

    idleRef.current = idle;

    /** Called as the pointer goes down on the stage. */
    const onPointerDown = useCallback((event: { pointerType: string }) => {
        woke.current = event.pointerType !== "mouse" && idleRef.current;
    }, []);

    /** Whether the tap now ending only brought the controls back. Read once per tap. */
    const consume = useCallback((): boolean => {
        const value = woke.current;

        woke.current = false;

        return value;
    }, []);

    return { onPointerDown, consume };
};

/**
 * A tap on a picture that is also a pause button: the player, the tasting, a running show of
 * stills (§14b, §14g). YouTube's rule, and the same on all three.
 *
 * - **A finger** shows the controls when they are hidden and hides them when they are showing.
 *   It never pauses -- that is the play button's job, and the controls are how you reach it.
 * - **A mouse** acts: by the time it clicks it has moved and the controls are up, and a click on
 *   the picture is the desktop players' pause.
 *
 * `hides` is whether the controls hide at all here. Where they do not -- the player in the page,
 * where the bar sits below the picture -- there is nothing to toggle, and a tap acts as a click.
 */
export const usePictureTap = (idle: boolean, hides: boolean, dismiss: () => void) => {
    const waking = useWakingTap(idle);
    const wakingDown = waking.onPointerDown;
    const consume = waking.consume;
    const touch = useRef(false);

    const onPointerDown = useCallback(
        (event: { pointerType: string }) => {
            touch.current = event.pointerType !== "mouse";
            wakingDown(event);
        },
        [wakingDown]
    );

    /** Settles the tap now ending: `act` runs only when it was a click rather than a reach. */
    const tap = useCallback(
        (act: () => void) => {
            const byTouch = touch.current;

            touch.current = false;

            // Consumed whatever else is true, so it cannot outlive the tap it belongs to.
            if (consume()) return;

            if (byTouch && hides) {
                dismiss();

                return;
            }

            act();
        },
        [consume, hides, dismiss]
    );

    return { onPointerDown, tap };
};
