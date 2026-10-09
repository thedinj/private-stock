"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Every page arrived at by going forward starts at its top (§14).
 *
 * Next scrolls a new page to its top only if that top is off screen when the page *first
 * renders* — and most pages here first render a short loading state while their query runs. On
 * a phone that state can still be taller than the screen, so the browser kept the page part way
 * down, Next judged its top visible, and the page then loaded around wherever that was: opening
 * a performer from a long list, or an item from the home page, landed far down the page. It
 * became common once lists grew portraits (2026-10-08), because you are further down when you
 * tap.
 *
 * So it is said once here instead of left to that judgement. Back and Forward are left alone —
 * returning to where you were is exactly what they are for, and Next restores it — and so is a
 * change of query alone, which is a filter or a page of the same list, each with its own rule.
 */
/** How soon after Back or Forward a new pathname counts as theirs. */
const POP_WINDOW_MS = 1_500;

export const ArrivalScroll: React.FC = () => {
    const pathname = usePathname();
    // When Back or Forward last happened. A time rather than a flag: one that changed only the
    // query moves no pathname, and a flag left standing would skip the next real arrival.
    const poppedAt = useRef(0);
    const first = useRef(true);

    useEffect(() => {
        const onPop = (): void => {
            poppedAt.current = Date.now();
        };

        window.addEventListener("popstate", onPop);

        return () => window.removeEventListener("popstate", onPop);
    }, []);

    // Before paint, so the new page is never seen at the old place.
    useLayoutEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }

        if (Date.now() - poppedAt.current < POP_WINDOW_MS) {
            poppedAt.current = 0;
            return;
        }

        window.scrollTo({ top: 0, behavior: "instant" });
    }, [pathname]);

    return null;
};
