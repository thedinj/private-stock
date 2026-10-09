"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Fullscreen that survives moving to the next item (§14b).
 *
 * **What goes fullscreen is the document, not the player.** The obvious implementation —
 * `requestFullscreen()` on the player's own container — is the one this replaces, and it had a
 * bug that could not be patched from inside it: the fullscreen element belongs to *this item's*
 * player, so stepping to the next item removes it from the document, and what the viewer is left
 * with is a fullscreen window with nothing filling it. Exactly what it looked like.
 *
 * Re-requesting on the new player was tried first and is not good enough. Entering fullscreen
 * needs a user gesture; pressing Next is one, but a video *ending* is not — so the one path that
 * runs for minutes unattended, autoplay rolling through a set (§14b), is the one that drops out
 * of fullscreen. A viewer watching a library from across the room is precisely who this is for.
 *
 * So the element that goes fullscreen is `document.documentElement`, which no navigation
 * replaces, and the player *fills* the screen rather than being it: `data-fullscreen` on the
 * container, and the CSS lays it over the page. Moving between items then involves no fullscreen
 * call at all — the window never left it — and the arriving player reads the state on its way in.
 *
 * It also fixes something the element version got wrong on its own terms: a menu in the control
 * bar is rendered in a portal at the end of the body, which is *outside* a fullscreened container
 * and therefore not painted at all. The speed menu did nothing in fullscreen. Over the page
 * rather than inside an element, everything on the page can be seen again.
 *
 * The intention outlives the component, because the component is what keeps being rebuilt. A
 * player that mounts finds the screen already taken and keeps it; a player that unmounts while
 * the screen is taken gives the next one a moment to arrive, and drops out if none does — so
 * walking a set stays fullscreen and going back to the library does not.
 */

/** How long a departing player's fullscreen is held open for its replacement. */
const HANDOFF_MS = 1_500;

/** Whether the viewer has asked for fullscreen and has not taken it back. */
let intended = false;

/** The pending drop-out, cancelled by whichever player mounts next. */
let handoff: ReturnType<typeof setTimeout> | null = null;

/**
 * How many holders of the screen are mounted right now.
 *
 * The handoff was written for one player at a time, replacing itself. The tasting (§14g) keeps a
 * video layer and a picture layer side by side and mounts or unmounts either as the set turns
 * from films to photographs -- and a player leaving while the other layer and the stage itself
 * are still there is not a departure. Only the last one out schedules the drop.
 */
let mounted = 0;

const clearHandoff = () => {
    if (handoff !== null) {
        clearTimeout(handoff);
        handoff = null;
    }
};

const held = () =>
    typeof document !== "undefined" && document.fullscreenElement === document.documentElement;

export interface PlayerFullscreen {
    /** Whether the window is given over to the player. */
    isFullscreen: boolean;
    /** Enter fullscreen, or leave it. Bound to the button and to `f`. */
    toggle: () => void;
    /**
     * Goes on the player's container.
     *
     * A callback ref rather than the ref object, so that arriving at the next item reads the
     * fullscreen state during the commit that mounts the player — one render before the browser
     * paints, rather than one frame after, which is a frame of the player at its in-page size
     * in the middle of a whole screen.
     */
    attachContainer: (node: HTMLDivElement | null) => void;
}

export const usePlayerFullscreen = (
    containerRef: RefObject<HTMLDivElement | null>
): PlayerFullscreen => {
    /**
     * False on the first render, and corrected during the commit that attaches the container.
     * The server has no fullscreen state to report, and guessing one here would be a hydration
     * mismatch.
     */
    const [isFullscreen, setIsFullscreen] = useState(false);

    const attachContainer = useCallback(
        (node: HTMLDivElement | null) => {
            containerRef.current = node;

            if (node) setIsFullscreen(held());
        },
        [containerRef]
    );

    useEffect(() => {
        const onChange = () => {
            setIsFullscreen(held());

            /**
             * Leaving is the viewer saying so — Escape, the button, the key — and it ends the
             * intention. Nothing else produces this event now: the fullscreen element is the
             * document, so no navigation of ours removes it.
             */
            if (!document.fullscreenElement) {
                intended = false;
                clearHandoff();
            }
        };

        document.addEventListener("fullscreenchange", onChange);

        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    /**
     * Holding the screen open across the gap between one player and the next.
     *
     * The mount half only cancels the drop-out: the window is still fullscreen, so there is
     * nothing to ask for. The unmount half is what makes leaving the viewer leave fullscreen.
     */
    useEffect(() => {
        clearHandoff();
        mounted += 1;

        return () => {
            mounted -= 1;

            if (!intended || mounted > 0) return;

            handoff = setTimeout(() => {
                handoff = null;
                intended = false;

                if (document.fullscreenElement) void document.exitFullscreen();
            }, HANDOFF_MS);
        };
    }, []);

    const toggle = useCallback(() => {
        if (document.fullscreenElement) {
            intended = false;
            void document.exitFullscreen();

            return;
        }

        intended = true;

        void document.documentElement.requestFullscreen().catch(() => {
            // Refused: no gesture behind it, or a browser forbidding it outright. The page is
            // unchanged, and the picture stays where it was.
            intended = false;
        });
    }, []);

    return { isFullscreen, toggle, attachContainer };
};
