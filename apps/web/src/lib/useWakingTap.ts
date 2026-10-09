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
