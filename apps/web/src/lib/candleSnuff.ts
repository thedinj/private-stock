import { DURATION, EASE, prefersReducedMotion } from "./motion";

/**
 * Snuffing the room on the way into a tasting or the showcase (§14, "Motion"; §14f, §14g).
 *
 * The light of the room closes to a point at the centre of the screen, like a candle being
 * put out, and only then does the mode open. It is done in the page rather than as a view
 * transition because entering also asks for full screen, and the viewport changing size in
 * the middle of a view transition makes the browser abandon it.
 *
 * The black is an element of our own laid over the shell, outside React, so it survives the
 * route change and stays over the screen until the mode's `CandleArrival` takes over from it.
 * Nothing is ever drawn over a film: by the time one is showing, both are gone.
 */

const OVERLAY_ID = "ps-snuff";
const ARRIVAL_KEY = "ps:candleArrival";

/** A radius the browser can interpolate, so the hole in the dark can close smoothly. */
const RADIUS = "--ps-snuff-r";

/** The black the room goes to. The tasting's and the showcase's own ground is near it. */
export const SNUFF_BLACK = "#050403";

let registered = false;

const registerRadius = () => {
    if (registered) return;
    registered = true;

    try {
        CSS.registerProperty({
            name: RADIUS,
            syntax: "<length>",
            inherits: false,
            initialValue: "0px",
        });
    } catch {
        // Already registered by an earlier load of this module, or unsupported: without it the
        // radius jumps rather than closes, and the room still goes dark before the mode opens.
    }
};

/** Put out the room, then `go`. Under reduced motion: `go`, at once. */
export const snuffThen = (go: () => void): void => {
    if (prefersReducedMotion() || typeof document === "undefined") {
        go();
        return;
    }

    registerRadius();
    document.getElementById(OVERLAY_ID)?.remove();

    const overlay = document.createElement("div");

    overlay.id = OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "10000",
        background: SNUFF_BLACK,
        pointerEvents: "none",
        // Black everywhere outside a circle at the centre; the circle shrinks to nothing.
        maskImage: `radial-gradient(circle at 50% 50%, transparent var(${RADIUS}), #000 calc(var(${RADIUS}) + 1px))`,
        webkitMaskImage: `radial-gradient(circle at 50% 50%, transparent var(${RADIUS}), #000 calc(var(${RADIUS}) + 1px))`,
    });
    overlay.style.setProperty(RADIUS, "0px");
    document.body.appendChild(overlay);

    try {
        sessionStorage.setItem(ARRIVAL_KEY, "1");
    } catch {
        // The mode then opens without its candle, straight onto its stage.
    }

    const closing = overlay.animate([{ [RADIUS]: "100vmax" }, { [RADIUS]: "0px" }], {
        duration: DURATION.signature,
        easing: EASE.in,
    });

    void closing.finished.then(go, go);

    // If the mode never arrives to take the dark away -- the navigation failed -- it lifts by
    // itself rather than leaving the app behind a black screen.
    window.setTimeout(() => overlay.remove(), DURATION.signature + 4000);
};

/**
 * Whether this mode was opened by a snuff, consumed as it is read; and the dark it left
 * behind, removed. The mode's own arrival takes the screen from here.
 */
export const takeSnuffArrival = (): boolean => {
    document.getElementById(OVERLAY_ID)?.remove();

    try {
        const value = sessionStorage.getItem(ARRIVAL_KEY);

        sessionStorage.removeItem(ARRIVAL_KEY);

        return value === "1" && !prefersReducedMotion();
    } catch {
        return false;
    }
};
