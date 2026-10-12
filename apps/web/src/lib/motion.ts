/**
 * How the cellar moves (§14, "Motion").
 *
 * One tempo for the whole app, chosen on the motion plates: **unhurried**. Arrivals and the few
 * signature moments take 600–900 ms, because the room has been there a long time and is in no
 * hurry to show you anything; small acknowledgements stay brisk, because a control that answers
 * slowly reads as a control that did not hear you. Every duration in the app's own motion comes
 * from here (TS) or from the matching `--ps-dur-*` variables (SCSS, `globals.scss`), so the
 * tempo is one decision rather than forty.
 *
 * **Reduced motion is honoured here, not at each call site.** The stylesheet's global rule
 * collapses CSS animations and transitions, but it cannot reach the Web Animations API, which
 * the grids and the navigation use. `animate()` below is the one way the app's code starts an
 * animation, and under reduced motion it does not start one at all.
 */

/** Durations in milliseconds. Mirrored by `--ps-dur-*` in globals.scss -- change both. */
export const DURATION = {
    /** A control acknowledging you: a hover, a press, a toggle. */
    brisk: 200,
    /** Something leaving: it should be gone before you wonder whether it is. */
    leave: 450,
    /** Something moving to a new place: a tile closing ranks, a page sliding in. */
    move: 600,
    /** Something arriving: a page's title, a new tile, a page of tiles. */
    arrive: 800,
    /** The few moments that are the app's own: the snuff into a tasting, the morph to the stage. */
    signature: 900,
} as const;

/** Mirrored by `--ps-ease-*` in globals.scss. */
export const EASE = {
    /** Decelerating into place: arrivals and moves. */
    out: "cubic-bezier(0.16, 1, 0.3, 1)",
    /** Accelerating away: leaving. */
    in: "cubic-bezier(0.7, 0, 0.84, 0)",
    /** Both ends eased: a thing travelling from one place to another in plain view. */
    inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
} as const;

/** Whether the viewer has asked for reduced motion. False on the server. */
export const prefersReducedMotion = (): boolean =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `element.animate`, or nothing under reduced motion.
 *
 * Returns the Animation so a caller can wait on `finished`, or null when nothing was started --
 * in which case the element is already where the animation would have left it, because every
 * animation in the app ends at the element's own resting style (`fill` is not used to hold an
 * end state).
 */
export const animate = (
    element: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
): Animation | null => {
    if (prefersReducedMotion() || typeof element.animate !== "function") return null;

    return element.animate(keyframes, { easing: EASE.out, ...options });
};
