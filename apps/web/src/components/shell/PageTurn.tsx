"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { navigationSettled, navigationStarted } from "@/lib/navigationPending";
import {
    canTransition,
    morphIntoStage,
    notifyRouteSettled,
    runTransition,
} from "@/lib/viewTransitions";

/** Routes outside the shell, or not pages at all: left to the browser and to Next. */
const OUTSIDE_SHELL = /^\/(api|tasting|showcase|login|register|setup)(\/|$)/;

const ITEM_PATH = /^\/media\/[^/]+$/;

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
 * for. A link that is a tile going to its item morphs instead of turning.
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

    useEffect(() => {
        notifyRouteSettled();
        navigationSettled();
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

            if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
            ) {
                return;
            }

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

            // A link in a dialog belongs to the dialog: it may replace rather than push, which a
            // listener cannot see, and the dialog closes as it goes in any case. Without View
            // Transitions there is nothing to take over either. Both are left to Link, and only
            // said to have started.
            if (anchor.closest('[role="dialog"]') || !canTransition()) {
                pending = { event, go: navigationStarted };
                return;
            }

            event.preventDefault();

            const href = url.pathname + url.search + url.hash;
            const frame = anchor.querySelector<HTMLElement>("[data-morph-frame]");

            pending = {
                event,
                go:
                    frame && ITEM_PATH.test(url.pathname)
                        ? () => morphIntoStage(frame, () => router.push(href))
                        : () => runTransition("turn", () => router.push(href)),
            };
        };

        const onBubble = (event: MouseEvent) => {
            if (pending?.event !== event) return;

            const { go } = pending;

            pending = null;
            navigationStarted();
            go();
        };

        document.addEventListener("click", onCapture, { capture: true });
        window.addEventListener("click", onBubble);

        return () => {
            document.removeEventListener("click", onCapture, { capture: true });
            window.removeEventListener("click", onBubble);
        };
    }, [router]);

    return null;
};
