import { prefersReducedMotion } from "./motion";

/**
 * Moving between places in the shell (§14, "Motion").
 *
 * Same-document View Transitions: the browser photographs the screen, the route changes
 * underneath, and the two pictures are animated into each other by the `::view-transition-*`
 * rules in `app/(app)/viewTransitions.scss`. Which rules apply is chosen by `data-vt` on the
 * root element, set here for the length of one transition:
 *
 *  - `turn` — the page turn: the old page sinks and fades, the new one rises into place, the
 *    header and nav hold still and the plate title changes in its own spot.
 *  - `morph` — a tile's frame grows into the viewer's stage, or the stage shrinks back into the
 *    tile it was opened from.
 *
 * Where the API is missing (Firefox at the time of writing) or reduced motion is asked for,
 * `runTransition` simply runs the navigation: there is no fallback animation, and none is
 * owed -- a plain cut is what every page did before.
 */

export type TransitionKind = "turn" | "morph";

/** How long a transition will hold the screen still waiting for the new page. */
const ROUTE_TIMEOUT_MS = 1500;

/** How long a morph waits, after the route, for the element it is morphing into. */
const TARGET_TIMEOUT_MS = 700;

const settleWaiters = new Set<() => void>();

/**
 * Called by `PageTurn` whenever the address it sees changes: the new route has rendered.
 *
 * Every waiter is released at once. Only one transition runs at a time -- starting a second
 * skips the first -- so there is never more than one waiter that matters.
 */
export const notifyRouteSettled = (): void => {
    settleWaiters.forEach((resolve) => resolve());
    settleWaiters.clear();
};

/**
 * Resolves when the next route has rendered, or after the timeout -- a slow route must never
 * hold the screen frozen on a photograph of the page being left.
 */
const routeSettled = (): Promise<void> =>
    new Promise((resolve) => {
        const done = () => {
            window.clearTimeout(timer);
            settleWaiters.delete(done);
            resolve();
        };
        const timer = window.setTimeout(done, ROUTE_TIMEOUT_MS);

        settleWaiters.add(done);
    });

/** The first element matching `selector`, polled for a few frames while the new page mounts. */
const elementSoon = (selector: string): Promise<HTMLElement | null> =>
    new Promise((resolve) => {
        const until = performance.now() + TARGET_TIMEOUT_MS;
        const look = () => {
            const found = document.querySelector<HTMLElement>(selector);

            if (found || performance.now() > until) resolve(found);
            else requestAnimationFrame(look);
        };

        look();
    });

export const canTransition = (): boolean =>
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !prefersReducedMotion();

/**
 * Elements given an inline transition name, cleared when the transition they were named for
 * ends. Per transition: a click during one starts another, which skips the first, and the
 * first's cleanup must not strip the names the second has just set.
 */
let named = new Set<HTMLElement>();

/** The transition now running, so a skipped one knows it is no longer the one to clean up. */
let current: ViewTransition | null = null;

/** The one name the morph uses, on whichever frame is the tile's half of it. */
const nameFrame = (frame: HTMLElement): void => {
    frame.style.viewTransitionName = "ps-stage";
    named.add(frame);
};

const clearNames = (names: Set<HTMLElement>) =>
    names.forEach((element) => (element.style.viewTransitionName = ""));

/**
 * Run `navigate` inside a view transition of `kind`, or plainly where that cannot be done.
 *
 * `afterRoute` runs inside the transition once the new page has rendered and before it is
 * photographed -- the morph's way back names the tile it is returning to there.
 */
export const runTransition = (
    kind: TransitionKind,
    navigate: () => void,
    afterRoute?: () => Promise<void>
): void => {
    if (!canTransition()) {
        navigate();
        return;
    }

    const root = document.documentElement;
    // Names set before this call (the tile, for a morph) belong to this transition; the
    // previous one's, if it is still running, are about to be skipped with it.
    const mine = named;

    named = new Set();
    root.dataset.vt = kind;

    const transition = document.startViewTransition(async () => {
        const settled = routeSettled();

        navigate();
        await settled;
        await afterRoute?.();
        // A name set while the route settled (the tile, on the way back) is this one's too.
        named.forEach((element) => mine.add(element));
        named = new Set();
    });

    current = transition;

    void transition.finished.finally(() => {
        clearNames(mine);

        if (current === transition) {
            current = null;
            delete root.dataset.vt;
        }
    });
};

/** A media id as a selector-safe attribute value. */
const byMediaId = (id: string): string => `[data-media-id="${CSS.escape(id)}"] [data-morph-frame]`;

/**
 * Opening an item from its tile: the tile's frame grows into the stage.
 *
 * The stage is named by the stylesheet while a morph runs (`[data-morph-stage]`), so only the
 * tile needs naming here. The viewer fetches its item after it mounts, so the stage may arrive
 * a few frames after the route; the transition waits briefly for it, and without it the tile
 * simply fades with the page.
 */
export const morphIntoStage = (tileFrame: HTMLElement, navigate: () => void): void => {
    if (canTransition()) nameFrame(tileFrame);

    runTransition("morph", navigate, async () => {
        await elementSoon("[data-morph-stage]");
    });
};

/**
 * Leaving the viewer by its own way back: the stage shrinks into the tile it was opened from,
 * if that tile is on the page we land on. The way back is usually `history.back()`, which
 * restores the list as it was left, so the tile is normally where it was.
 */
export const morphOutOfStage = (itemId: string, navigate: () => void): void => {
    runTransition("morph", navigate, async () => {
        const frame = await elementSoon(byMediaId(itemId));

        if (frame) nameFrame(frame);
    });
};
