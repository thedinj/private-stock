"use client";

import { useEffect } from "react";

/**
 * The light the screen throws on the study wall (§14).
 *
 * The frame has always cast a warm glow, and it earned its exception to the rule that warmth
 * lives in the chrome: a lit screen in a dark room genuinely does throw light, and without it
 * the player read as a black rectangle pasted onto a warm page. But the glow was a *fixed*
 * amber — the same colour for a night scene and a snowfield, which is the one thing real
 * spill light never is.
 *
 * So it is sampled. A 32×18 canvas takes the picture five times a second, averages it, and
 * writes the result into two custom properties the stage's shadow is drawn from. A dark scene
 * dims the room; a bright one lifts it; a fire on screen puts firelight on the wall.
 *
 * **Everything about this is deliberately cheap.** 576 pixels is a rounding error next to the
 * frame the GPU already drew, the interval is 200 ms rather than per-frame because light on a
 * wall has no business being frame-accurate, and the result is eased toward rather than
 * assigned so a cut between shots does not strobe the room. Sampling stops when the tab is
 * hidden and when nothing is playing.
 *
 * **And it is an enhancement, not a feature.** Under `prefers-reduced-motion` it never starts;
 * if the canvas refuses to give up pixels it stops for good. In both cases the CSS default
 * stands, which is the static amber glow that was already there.
 *
 * The media element is found by query rather than passed in. The player owns its `<video>` and
 * has a wide enough surface already; a ref threaded out purely so the page could read its
 * pixels would make the light part of the player's contract, and it is part of the room's.
 */

/** 32×18 keeps the sample one 16:9 frame wide and costs nothing to average. */
const SAMPLE_W = 32;
const SAMPLE_H = 18;

/** Five times a second. Light on a wall does not need to be frame-accurate. */
const INTERVAL_MS = 200;

/** How far each sample moves the room. Lower is calmer across a cut. */
const EASE = 0.22;

/** Below this the picture is essentially black, and a black wall is the right answer. */
const FLOOR = 0.12;

interface Light {
    r: number;
    g: number;
    b: number;
}

/** Amber, the same colour the CSS falls back to, so the first ease starts from rest. */
const REST: Light = { r: 208, g: 134, b: 64 };

/**
 * Pushes a sampled average away from grey.
 *
 * An averaged frame is muddy by construction — mixing a whole picture down to one pixel
 * cancels most of its colour. Spill light on a wall is not muddy, so the chroma is pulled back
 * out around the sample's own luminance rather than invented.
 */
const saturate = (light: Light, amount: number): Light => {
    const grey = 0.2126 * light.r + 0.7152 * light.g + 0.0722 * light.b;

    return {
        r: Math.max(0, Math.min(255, grey + (light.r - grey) * amount)),
        g: Math.max(0, Math.min(255, grey + (light.g - grey) * amount)),
        b: Math.max(0, Math.min(255, grey + (light.b - grey) * amount)),
    };
};

export const useSpillLight = (stageRef: React.RefObject<HTMLElement | null>): void => {
    useEffect(() => {
        const stage = stageRef.current;

        if (!stage || typeof window === "undefined") {
            return;
        }

        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }

        const canvas = document.createElement("canvas");

        canvas.width = SAMPLE_W;
        canvas.height = SAMPLE_H;

        const context = canvas.getContext("2d", { willReadFrequently: true });

        if (!context) {
            return;
        }

        let current = REST;
        let timer: ReturnType<typeof setInterval> | null = null;

        const stop = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };

        const sample = (): void => {
            if (document.hidden) {
                return;
            }

            /**
             * The element that lights the room volunteers, by carrying `data-spill`.
             *
             * This was `querySelector("video") ?? querySelector("img")` — the video first, then
             * an image — so that no decorative image the player grew later could silently become
             * the thing lighting the room. Stills in a show broke it the way document order
             * always breaks: a still stage holds *two* stacked images, one of them the picture
             * you are about to see, and the ordering rule would have lit the walls from a
             * photograph nobody can see yet.
             *
             * Marking the source is the stronger rule rather than a relaxation of the old one. A
             * decoration cannot light the room because it would have to ask; and "the active one
             * of two identical elements" is not something document order can express at all.
             */
            const source = stage.querySelector("[data-spill]");

            // The instance checks are the narrowing as well as the guard: `querySelector`
            // promises an `Element`, and only these two can be drawn to a canvas.
            if (!(source instanceof HTMLVideoElement) && !(source instanceof HTMLImageElement)) {
                return;
            }

            // A video that has not decoded a frame yet, or an image still loading, would paint
            // the canvas black and put the room out.
            if (source instanceof HTMLVideoElement && source.readyState < 2) {
                return;
            }

            if (source instanceof HTMLImageElement && !source.complete) {
                return;
            }

            let pixels: Uint8ClampedArray;

            try {
                context.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
                pixels = context.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
            } catch {
                // A tainted canvas. Everything here is same-origin, so this should not
                // happen — and if it ever does, the static glow in CSS is a perfectly good
                // answer and asking again every 200 ms is not.
                stop();
                return;
            }

            let r = 0;
            let g = 0;
            let b = 0;

            for (let i = 0; i < pixels.length; i += 4) {
                r += pixels[i];
                g += pixels[i + 1];
                b += pixels[i + 2];
            }

            const count = pixels.length / 4;
            const target = saturate({ r: r / count, g: g / count, b: b / count }, 1.65);

            current = {
                r: current.r + (target.r - current.r) * EASE,
                g: current.g + (target.g - current.g) * EASE,
                b: current.b + (target.b - current.b) * EASE,
            };

            const luminance = (0.2126 * current.r + 0.7152 * current.g + 0.0722 * current.b) / 255;

            stage.style.setProperty(
                "--ps-spill",
                `${Math.round(current.r)}, ${Math.round(current.g)}, ${Math.round(current.b)}`
            );
            // Amplitude as well as colour: a dark scene should dim the room, not merely
            // change its hue. Square-rooted, because perceived brightness is not linear and
            // an unadjusted dark scene reads as the effect having failed.
            stage.style.setProperty(
                "--ps-spill-amp",
                (FLOOR + (1 - FLOOR) * Math.sqrt(Math.min(1, luminance * 1.6))).toFixed(3)
            );
        };

        const start = (): void => {
            if (timer === null) {
                timer = setInterval(sample, INTERVAL_MS);
            }
        };

        const onVisibility = (): void => (document.hidden ? stop() : start());

        start();
        // One immediate sample, so a still or a paused video lights the room on arrival
        // rather than at the end of the first interval.
        sample();
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisibility);
            stage.style.removeProperty("--ps-spill");
            stage.style.removeProperty("--ps-spill-amp");
        };
    }, [stageRef]);
};
