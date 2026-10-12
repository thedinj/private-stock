"use client";

import { useEffect } from "react";

import { prefersReducedMotion } from "@/lib/motion";

/**
 * The candle the gilt chrome catches (§14, "Motion"; the light itself is in globals.scss).
 *
 * Keeps `--ps-mx`/`--ps-my` on the root at the pointer, one write per frame at most, and
 * `data-candle-lit` on the root while there is a pointer to follow. A mouse or a pen carries
 * the candle; a finger does not, because a touch is a tap rather than a hand moving through the
 * room, and a light that jumped to every tap would read as a flash. So on a touch screen, and
 * under reduced motion, the candle is set down once -- high on the left, where the room's own
 * firelight is -- and left there.
 *
 * Renders nothing. Mounted once, in the providers.
 */
export const CandleLight: React.FC = () => {
    useEffect(() => {
        const root = document.documentElement;
        const setLight = (x: string, y: string) => {
            root.style.setProperty("--ps-mx", x);
            root.style.setProperty("--ps-my", y);
        };
        const setDown = () => {
            setLight("18vw", "-10vh");
            root.setAttribute("data-candle-lit", "");
        };

        const fine = window.matchMedia("(pointer: fine)").matches;
        if (!fine || prefersReducedMotion()) {
            setDown();
            return () => root.removeAttribute("data-candle-lit");
        }

        let frame = 0;
        let x = 0;
        let y = 0;
        const onMove = (event: PointerEvent) => {
            if (event.pointerType === "touch") return;
            x = event.clientX;
            y = event.clientY;
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                setLight(`${x}px`, `${y}px`);
                root.setAttribute("data-candle-lit", "");
            });
        };
        // The candle leaves with the hand: off the window, or to another one.
        const onLeave = () => root.removeAttribute("data-candle-lit");

        window.addEventListener("pointermove", onMove, { passive: true });
        document.documentElement.addEventListener("pointerleave", onLeave);
        window.addEventListener("blur", onLeave);

        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("pointermove", onMove);
            document.documentElement.removeEventListener("pointerleave", onLeave);
            window.removeEventListener("blur", onLeave);
            root.removeAttribute("data-candle-lit");
        };
    }, []);

    return null;
};
