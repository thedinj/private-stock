import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { animate, DURATION, EASE, prefersReducedMotion } from "@/lib/motion";

/**
 * A rack that shows its changes (§14, "Motion").
 *
 * Every keyed grid and list in the app used to change by cutting: a tile trashed from the
 * middle of a page left a hole that the rest jumped into, a filter swapped the whole grid in one
 * frame, and a page turn replaced sixty tiles at once. This hook makes each of those a movement
 * you can follow, by comparing where every child was at the last commit with where it is now:
 *
 * - **Close ranks.** A child that left sinks and fades where it stood, and the children after it
 *   glide forward into the gap.
 * - **Reshuffle.** When the old and new sets overlap — a filter or a sort changed — the children
 *   that stayed slide to their new places and the newcomers fade up into theirs.
 * - **Arrivals.** When the caller says the newcomers really are new (a scan landing while you
 *   watch), they settle in from just above, one after another, and carry `data-arrived` for a few
 *   seconds, which the tile's stylesheet draws as a thin gilt edge.
 * - **Racking.** When nothing overlaps — first load, a new page, a wholly different result — the
 *   children are set into the rack on a diagonal wave from the top-left corner.
 *
 * **Frames only.** The child is animated as a whole — never the picture inside it on its own —
 * and nothing is tinted (§14: texture in the chrome, never behind the media). Children carry
 * `data-flip-key`; the container gets the returned `ref`, a callback ref so a grid that is
 * swapped for a spinner and back is picked up again. The container must be `position: relative`
 * for the ghosts and the measurements, which the hook sets itself so a call site cannot forget.
 *
 * **Leavers are caught by a MutationObserver.** By the time a layout effect runs React has
 * already removed them, but the observer is handed the real detached nodes, which go back in as
 * absolutely placed ghosts at their old positions until their fade ends. A ghost has no key and is
 * never measured.
 *
 * **Bounded by the screen.** Only children within about a screen of the viewport move; the rest
 * simply appear where they are, so a long list costs what is visible. **Reduced motion does
 * nothing at all**, ghosts included: the list changes the way it always did.
 */

interface Place {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * How long a promise of arrivals stands. Long enough for the refetch it was made for to land;
 * short enough that a refetch which brought nothing new cannot leave it waiting to mislabel the
 * next filter change's newcomers as new to the library.
 */
const EXPECT_MS = 10_000;
/** How long an arrival keeps its gilt edge before the attribute is taken off again. */
const ARRIVED_MS = 4_500;
/** Staggers, kept short so a wave of twenty is still over in well under a second. */
const NEWCOMER_STAGGER = 70;
const ARRIVAL_STAGGER = 120;
const RACK_STEP = 45;
/** The longest any child waits for its turn, whatever its place in the wave. */
const MAX_DELAY = 420;

const KEY = "flipKey";

/** Layout position inside the container, ignoring any transform an animation has on it. */
const placeOf = (element: HTMLElement): Place => ({
    x: element.offsetLeft,
    y: element.offsetTop,
    w: element.offsetWidth,
    h: element.offsetHeight,
});

/** Within about a screen of the viewport, measured from the container's own position. */
const nearScreen = (container: HTMLElement, place: Place): boolean => {
    const top = container.getBoundingClientRect().top + place.y;
    const screen = window.innerHeight;

    return top < screen * 2 && top + place.h > -screen;
};

const keyedChildren = (container: HTMLElement): HTMLElement[] =>
    Array.from(container.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement && KEY in child.dataset
    );

const stop = (element: Element): void => element.getAnimations().forEach((a) => a.cancel());

/** The row and column of each place, counted from the distinct tops and lefts in the set. */
const gridIndex = (places: Place[]): { row: number; col: number }[] => {
    const tops = [...new Set(places.map((p) => p.y))].sort((a, b) => a - b);
    const lefts = [...new Set(places.map((p) => p.x))].sort((a, b) => a - b);

    return places.map((p) => ({ row: tops.indexOf(p.y), col: lefts.indexOf(p.x) }));
};

interface FlipGridOptions {
    /**
     * Every newcomer that joins an overlapping set is an arrival. For a grid whose live
     * updates are applied as they come (the home shelves), where nothing else adds to it.
     */
    live?: boolean;
}

export const useFlipGrid = <T extends HTMLElement = HTMLDivElement>(
    keys: readonly string[],
    { live = false }: FlipGridOptions = {}
) => {
    const container = useRef<T | null>(null);
    const [element, setElement] = useState<T | null>(null);
    const places = useRef(new Map<string, Place>());
    /** Old places of the keys that left at the last commit, for the observer to ghost. */
    const departed = useRef(new Map<string, Place>());
    /** Until when the next change's newcomers count as arrivals; 0 for not expected. */
    const arrivalsUntil = useRef(0);
    const timers = useRef(new Set<number>());

    const signature = keys.join("\n");

    const record = useCallback(() => {
        const host = container.current;
        if (!host) return;

        const next = new Map<string, Place>();
        for (const child of keyedChildren(host)) {
            next.set(child.dataset[KEY] as string, placeOf(child));
        }
        places.current = next;
    }, []);

    /**
     * The container, as a callback ref. Positioned here rather than in an effect, so the very
     * first measurement is already relative to it; and a new container starts with no history,
     * so whatever it first shows is racked rather than compared with a grid that has gone.
     */
    const ref = useCallback((node: T | null) => {
        if (node && getComputedStyle(node).position === "static") node.style.position = "relative";
        container.current = node;
        places.current = new Map();
        setElement(node);
    }, []);

    /** Say that the next change brings genuinely new items, so they arrive rather than appear. */
    const expectArrivals = useCallback(() => {
        arrivalsUntil.current = Date.now() + EXPECT_MS;
    }, []);

    useLayoutEffect(() => {
        const host = container.current;
        if (!host) return;

        const before = places.current;
        const arrivals = live || Date.now() < arrivalsUntil.current;
        arrivalsUntil.current = 0;

        const children = keyedChildren(host);
        const now = new Map(children.map((child) => [child.dataset[KEY] as string, child]));

        departed.current = new Map([...before].filter(([key]) => !now.has(key)));
        record();

        if (prefersReducedMotion() || children.length === 0) return;

        const overlap = children.some((child) => before.has(child.dataset[KEY] as string));

        if (!overlap) {
            // Racking: a new set entirely, dealt in from the top-left corner.
            const placed = children.map(placeOf);
            const index = gridIndex(placed);

            children.forEach((child, i) => {
                if (!nearScreen(host, placed[i])) return;

                stop(child);
                animate(
                    child,
                    [
                        { opacity: 0, transform: "translateY(10px)" },
                        { opacity: 1, transform: "none" },
                    ],
                    {
                        duration: DURATION.leave,
                        delay: Math.min((index[i].row + index[i].col) * RACK_STEP, MAX_DELAY),
                        fill: "backwards",
                    }
                );
            });

            return;
        }

        let newcomer = 0;

        for (const child of children) {
            const key = child.dataset[KEY] as string;
            const place = places.current.get(key) as Place;
            const old = before.get(key);

            if (!nearScreen(host, place)) continue;

            if (old) {
                const dx = old.x - place.x;
                const dy = old.y - place.y;
                if (dx === 0 && dy === 0) continue;

                stop(child);
                animate(
                    child,
                    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
                    { duration: DURATION.move, easing: EASE.out }
                );
                continue;
            }

            stop(child);

            if (arrivals) {
                child.dataset.arrived = "";
                const timer = window.setTimeout(() => {
                    delete child.dataset.arrived;
                    timers.current.delete(timer);
                }, ARRIVED_MS);
                timers.current.add(timer);

                animate(
                    child,
                    [
                        {
                            opacity: 0,
                            transform: "translateY(-10px) scale(0.97)",
                            filter: "blur(2px)",
                        },
                        { opacity: 1, transform: "none", filter: "none" },
                    ],
                    {
                        duration: DURATION.arrive,
                        delay: Math.min(DURATION.brisk + newcomer * ARRIVAL_STAGGER, MAX_DELAY * 2),
                        fill: "backwards",
                    }
                );
            } else {
                animate(
                    child,
                    [
                        { opacity: 0, transform: "translateY(8px)" },
                        { opacity: 1, transform: "none" },
                    ],
                    {
                        duration: DURATION.arrive,
                        delay: Math.min(DURATION.brisk + newcomer * NEWCOMER_STAGGER, MAX_DELAY),
                        fill: "backwards",
                    }
                );
            }

            newcomer++;
        }
        // Keyed on the set and its order, not on the array's identity: a refetch returning the
        // same items in the same order is not a change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature, element]);

    useEffect(() => {
        const host = element;
        if (!host) return;

        /** The leavers, put back as ghosts where they stood until they have faded. */
        const observer = new MutationObserver((records) => {
            if (prefersReducedMotion()) return;

            for (const record of records) {
                record.removedNodes.forEach((node) => {
                    if (!(node instanceof HTMLElement) || node.isConnected) return;

                    const key = node.dataset[KEY];
                    const place = key ? departed.current.get(key) : undefined;
                    if (!key || !place || !nearScreen(host, place)) return;

                    departed.current.delete(key);
                    delete node.dataset[KEY];
                    delete node.dataset.arrived;
                    // A ghost plays nothing: a preview restarting in a tile on its way out
                    // would be the one moving picture on a page that just asked for less.
                    node.querySelectorAll("video").forEach((video) => video.remove());
                    stop(node);
                    Object.assign(node.style, {
                        position: "absolute",
                        left: `${place.x}px`,
                        top: `${place.y}px`,
                        width: `${place.w}px`,
                        height: `${place.h}px`,
                        margin: "0",
                        pointerEvents: "none",
                        zIndex: "0",
                    });
                    node.setAttribute("aria-hidden", "true");
                    node.setAttribute("inert", "");
                    host.appendChild(node);

                    const leaving = animate(
                        node,
                        [
                            { opacity: 1, transform: "none" },
                            { opacity: 0, transform: "translateY(6px) scale(0.92)" },
                        ],
                        { duration: DURATION.leave, easing: EASE.in, fill: "forwards" }
                    );

                    if (leaving)
                        void leaving.finished.then(
                            () => node.remove(),
                            () => node.remove()
                        );
                    else node.remove();
                });
            }
        });

        observer.observe(host, { childList: true });

        const resize = new ResizeObserver(() => record());
        resize.observe(host);

        const pending = timers.current;

        return () => {
            observer.disconnect();
            resize.disconnect();
            pending.forEach((timer) => window.clearTimeout(timer));
            pending.clear();
        };
    }, [element, record]);

    return { ref, expectArrivals };
};
