"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { roomKey } from "@/lib/activeDomain";
import { queryKeys } from "@/lib/api/queryKeys";
import {
    DEFAULT_VIEW,
    effectiveSort,
    newShuffleSeed,
    parseView,
    viewToRequestParams,
    type LibraryView,
    type ScreenFit,
} from "@/lib/libraryQuery";
import { fetchLibraryPage, setAddress, usePlayFromTop } from "@/lib/playFromTop";
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

const PORTRAIT = "(orientation: portrait)";

/** Which way up the window is now. A square window reads as portrait, as CSS reads it. */
const windowFit = (): ScreenFit => (window.matchMedia(PORTRAIT).matches ? "portrait" : "landscape");

/**
 * Whether a picture fills a screen held this way up: the same way up, or square -- the rule the
 * server's `fits` filter applies. A picture whose size is not known yet is given the benefit:
 * stopping a video over a doubt would be worse than a strip between bars.
 */
export const pictureFits = (
    picture: { width: number | null; height: number | null },
    screen: ScreenFit
): boolean => {
    const { width, height } = picture;

    if (!width || !height || width === height) return true;

    return width > height === (screen === "landscape");
};

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

/**
 * How long the screen has to stay turned before the screening follows it. Long enough for a
 * tablet on a lap to wobble through the other way and back, and for the browser's own rotation
 * to finish; short enough to feel like an answer to the turn.
 */
const SETTLE_MS = 700;

/** How long "nothing in this room fits that way up" is believed before it is asked again. */
const NOTHING_FITS_MS = 10 * 60_000;

/** Sets found empty, by their filter less the shuffle -- so a screening does not ask each step. */
const nothingFits = new Map<string, number>();

const emptinessKey = (view: LibraryView): string =>
    viewToRequestParams({ ...view, seed: 0, page: 0 }).toString();

interface ScreeningFitInput {
    /** Whether the viewer was opened by a private screening. */
    active: boolean;
    /** The address of the set behind the viewer. */
    returnTo: string | null;
    /** The video on screen, once it has loaded; null for a still or while it loads. */
    item: { id: string; width: number | null; height: number | null } | null;
    /** Put a new set behind the item on screen without leaving it. */
    carry: (href: string, itemId: string) => void;
}

/**
 * "Fits", kept true while a screening plays (§14h, "Turning the screen").
 *
 * The set behind the viewer is made to agree with the room's choice and the way the screen is
 * held now -- when the toggle is pressed, when the screen is turned and has settled, and on
 * arrival at each item in case a turn happened in between. Agreeing never interrupts a video that
 * suits the new set: it plays on with the new set put behind it, and Next is that set's first
 * item. Only a video the wrong way up for a screen just turned is moved on from, to the first
 * that fits -- which is what turning the screen asked for.
 *
 * Nothing that fits is the whole room, as at the press: a room whose videos are all one way up
 * keeps playing all of them on a screen held the other way.
 */
export const useScreeningFit = ({
    active,
    returnTo,
    item,
    carry,
}: ScreeningFitInput): { fit: boolean; toggle: () => void } => {
    const [fit, setFit] = useState(readScreeningFit);
    const queryClient = useQueryClient();
    const playFromTop = usePlayFromTop();

    const latest = useRef({ returnTo, item, carry, playFromTop, fit });
    latest.current = { returnTo, item, carry, playFromTop, fit };

    /** One agreement at a time; a call during one runs again after it, on what is true then. */
    const busy = useRef(false);
    const again = useRef(false);

    const hasAny = useCallback(
        async (view: LibraryView): Promise<boolean> => {
            const key = emptinessKey(view);
            const emptyAt = nothingFits.get(key);

            if (emptyAt !== undefined && Date.now() - emptyAt < NOTHING_FITS_MS) return false;

            const filter = viewToRequestParams({ ...view, sort: effectiveSort(view) });
            // The key and the page `playFromTop` asks for, so going on to it is a cache hit.
            const first = await queryClient.fetchQuery({
                queryKey: queryKeys.media.page(filter.toString(), 0),
                queryFn: () => fetchLibraryPage(filter, 0),
                staleTime: 30_000,
            });

            if (first.items.length > 0) return true;

            nothingFits.set(key, Date.now());

            return false;
        },
        [queryClient]
    );

    const agree = useCallback(async (): Promise<void> => {
        if (busy.current) {
            again.current = true;
            return;
        }

        busy.current = true;

        try {
            do {
                again.current = false;

                const { returnTo: href, item: playing, fit: wanted } = latest.current;

                if (!href || !playing) return;

                const view = parseView(new URLSearchParams(href.split("?")[1] ?? ""));
                const screen = wanted ? windowFit() : null;

                // Already the set this screen asks for: nothing to ask the server.
                if (view.fits === screen) continue;

                const reseeded = { ...view, seed: newShuffleSeed(), page: 0 };
                const fits =
                    screen !== null && (await hasAny({ ...reseeded, fits: screen }))
                        ? screen
                        : null;

                if (view.fits === fits) continue;

                const next = { ...reseeded, fits };

                // Read again: the item may have changed while the server was asked.
                const now = latest.current;

                if (now.returnTo !== href || now.item?.id !== playing.id) {
                    again.current = true;
                    continue;
                }

                if (fits === null || pictureFits(playing, fits)) {
                    now.carry(setAddress(next, true), playing.id);
                } else {
                    await now.playFromTop(next, false, true);
                }
            } while (again.current);
        } catch {
            // The set behind stays as it was; the next turn or press asks again.
        } finally {
            busy.current = false;
        }
    }, [hasAny]);

    // A turn of the screen, once it has settled.
    useEffect(() => {
        if (!active || !fit) return;

        const query = window.matchMedia(PORTRAIT);
        let timer: ReturnType<typeof setTimeout> | null = null;

        const onChange = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => void agree(), SETTLE_MS);
        };

        query.addEventListener("change", onChange);

        return () => {
            query.removeEventListener("change", onChange);
            if (timer !== null) clearTimeout(timer);
        };
    }, [active, fit, agree]);

    // Each arrival, for a turn made while the viewer was between items.
    const itemId = item?.id ?? null;

    useEffect(() => {
        if (active && fit && itemId !== null) void agree();
    }, [active, fit, itemId, agree]);

    const toggle = useCallback(() => {
        const next = !latest.current.fit;

        latest.current.fit = next;
        setFit(next);
        writeScreeningFit(next);
        void agree();
    }, [agree]);

    return { fit, toggle };
};
