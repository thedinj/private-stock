"use client";

import { roomKey } from "@/lib/activeDomain";
import { DEFAULT_VIEW, newShuffleSeed, type ScreenFit } from "@/lib/libraryQuery";
import { usePlayFromTop } from "@/lib/playFromTop";
import { enterPlayerFullscreen } from "@/lib/usePlayerFullscreen";

/**
 * Private screening (§14h): the room's videos, freshly shuffled, opened at the first one in the
 * viewer, full screen -- only those that fill the screen the way it is held, when the room says
 * so.
 */

const FIT_KEY = "ps:screeningFit";

/**
 * Whether this room's screenings keep to videos that fill the screen (§14h).
 *
 * Per room, because the answer is about the room's videos: one whose videos are all one way up
 * has no use for it. Storage rather than a setting, like the reel target -- losing it costs one
 * tap -- and on until the room is told otherwise.
 */
export const readScreeningFit = (): boolean => {
    try {
        return window.localStorage.getItem(roomKey(FIT_KEY)) !== "all";
    } catch {
        return true;
    }
};

export const writeScreeningFit = (fit: boolean): void => {
    try {
        if (fit) window.localStorage.removeItem(roomKey(FIT_KEY));
        else window.localStorage.setItem(roomKey(FIT_KEY), "all");
    } catch {
        // Storage refused: this deal still honours the tap, the next one forgets it.
    }
};

/** Which way up the window is now. A square window reads as portrait, as CSS reads it. */
const windowFit = (): ScreenFit =>
    window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape";

/** One deal at a time across the header and the viewer: a press while one is on its way is it. */
let dealing = false;

/**
 * Deal a screening. `fit` overrides the room's choice for this deal, for the toggle that has
 * just changed it.
 */
export const useScreening = (): ((fit?: boolean) => void) => {
    const playFromTop = usePlayFromTop();

    return (fit = readScreeningFit()) => {
        if (dealing) return;
        dealing = true;

        // Asked for first, inside the press: by the time the page arrives the gesture is gone.
        const undo = enterPlayerFullscreen();
        const view = {
            ...DEFAULT_VIEW,
            kind: "video" as const,
            mode: "grid" as const,
            sort: "random" as const,
            seed: newShuffleSeed(),
        };

        // Nothing this way up is the whole room rather than nothing at all (§14h).
        const deal = async () =>
            (fit && (await playFromTop({ ...view, fits: windowFit() }, false, true))) ||
            playFromTop(view, false, true);

        deal()
            .then((opened) => {
                if (!opened) undo();
            })
            .catch(() => undo())
            .finally(() => {
                dealing = false;
            });
    };
};
