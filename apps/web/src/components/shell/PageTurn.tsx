"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { navigationSettled, navigationStarted } from "@/lib/navigationPending";
import {
    abandonOpening,
    isPlainClick,
    itemIdOf,
    openingSettled,
    useItemWarming,
    useOpenItem,
} from "@/lib/openItem";
import {
    canTransition,
    morphIntoStage,
    notifyRouteSettled,
    runTransition,
} from "@/lib/viewTransitions";

/** Routes outside the shell, or not pages at all: left to the browser and to Next. */
const OUTSIDE_SHELL = /^\/(api|tasting|showcase|login|register|setup)(\/|$)/;

/**
 * What lights while an item link is on its way: the tile's frame, which is also what morphs, or
 * a picture that is not a morph tile but says it can be lit (`data-open-frame`). A text link has
 * neither, and is acknowledged by the header's rail alone.
 */
const openingMarker = (anchor: HTMLAnchorElement): HTMLElement | null =>
    anchor.matches("[data-open-frame]")
        ? anchor
        : anchor.querySelector<HTMLElement>("[data-morph-frame], [data-open-frame]");

/**
 * The page turn (§14, "Motion"): every in-app link inside the shell, run as a view transition.
 *
 * Next's `<Link>` gives up when its click has already been `preventDefault`ed, so a listener
 * in the capture phase can take the navigation over before Link sees it, and run the same
 * `router.push` inside `document.startViewTransition`. Each link's own `onClick` still runs in
 * the bubble phase as before -- a tile still records the view being left, a nav link still
 * closes the phone's menu.
 *
 * Only a plain left click on a same-origin link that changes the page is taken: a modified
 * click, a new tab, a download, a hash, or the page you are already on all go the ordinary way,
 * and so does everything when the browser has no View Transitions or reduced motion is asked
 * for -- except a link to an item. A link that is a tile going to its item morphs instead of
 * turning.
 *
 * **Links to an item are opened, not just followed** (§14, "Waiting", `lib/openItem.ts`): the
 * tile is lit at once, the item is warmed, and only then does the morph or the turn start. That
 * is taken over with or without View Transitions, so a browser that has none (Firefox) or a
 * viewer who asked for reduced motion gets the same acknowledgement and the same warm cache --
 * only the movement is left out. Pressing or resting on any item link warms it too
 * (`useItemWarming`), which is mounted here for the whole shell.
 *
 * A click that a handler inside the link stops from propagating is left alone (see below).
 *
 * It also tells the transition when the new route has rendered, which is the one thing the
 * transition cannot find out for itself: the address this component sees changing is that.
 *
 * And it says when a navigation starts and ends for the header's activity rail, whether or not
 * the navigation turns: the decision about which clicks are navigations is made here and
 * nowhere else, so a browser without View Transitions still shows that a page is on its way.
 */
export const PageTurn: React.FC = () => {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const address = `${pathname}?${searchParams.toString()}`;
    const openItem = useOpenItem();

    useItemWarming();

    useEffect(() => {
        notifyRouteSettled();
        navigationSettled();
        openingSettled();
    }, [address]);

    useEffect(() => {
        /**
         * Two listeners, because the decision needs two moments.
         *
         * In the capture phase, before Link has seen the click, the navigation is taken: the
         * default is prevented, so Link stands down. Whether to *make* it waits for the click to
         * come back out to `window`, after every React handler has run -- React listens on the
         * document, so a handler that calls `stopPropagation` (the tile's selection checkbox,
         * which sits inside the tile's link) stops the click before it gets there, and nothing
         * is navigated, exactly as Link would not have navigated either.
         */
        let pending: { event: MouseEvent; go: () => void } | null = null;

        const onCapture = (event: MouseEvent) => {
            pending = null;

            if (event.defaultPrevented || !isPlainClick(event)) return;

            const target = event.target;
            if (!(target instanceof Element)) return;

            const anchor = target.closest<HTMLAnchorElement>("a[href]");
            if (!anchor || anchor.hasAttribute("download")) return;
            if (anchor.target && anchor.target !== "_self") return;

            const url = new URL(anchor.href, window.location.href);
            if (url.origin !== window.location.origin || OUTSIDE_SHELL.test(url.pathname)) return;

            // A hash on this page, or this page again: nothing to turn to.
            if (url.pathname + url.search === window.location.pathname + window.location.search) {
                return;
            }

            const itemId = itemIdOf(url);

            // A link in a dialog belongs to the dialog: it may replace rather than push, which a
            // listener cannot see, and the dialog closes as it goes in any case. Without View
            // Transitions there is nothing to take over either -- unless the link opens an item,
            // which is warmed first however it then arrives. Both are left to Link, and only
            // said to have started.
            if (anchor.closest('[role="dialog"]') || (!itemId && !canTransition())) {
                pending = {
                    event,
                    go: () => {
                        abandonOpening();
                        navigationStarted();
                    },
                };
                return;
            }

            event.preventDefault();

            const href = url.pathname + url.search + url.hash;
            const push = () => router.push(href);

            if (!itemId) {
                pending = {
                    event,
                    go: () => {
                        abandonOpening();
                        navigationStarted();
                        runTransition("turn", push);
                    },
                };
                return;
            }

            // Both fall back to a plain push where View Transitions cannot run.
            const frame = anchor.querySelector<HTMLElement>("[data-morph-frame]");
            const marker = openingMarker(anchor);

            pending = {
                event,
                go: () =>
                    openItem({
                        id: itemId,
                        href,
                        marker,
                        navigate: frame
                            ? () => morphIntoStage(frame, push)
                            : () => runTransition("turn", push),
                    }),
            };
        };

        const onBubble = (event: MouseEvent) => {
            if (pending?.event !== event) return;

            const { go } = pending;

            pending = null;
            go();
        };

        document.addEventListener("click", onCapture, { capture: true });
        window.addEventListener("click", onBubble);

        return () => {
            document.removeEventListener("click", onCapture, { capture: true });
            window.removeEventListener("click", onBubble);
        };
    }, [router, openItem]);

    return null;
};
