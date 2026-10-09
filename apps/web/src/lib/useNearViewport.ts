"use client";

import { useEffect, useRef, useState } from "react";

/** How early to ask: a screen's worth, so the answer is usually there before anybody arrives. */
const NEAR_MARGIN = "600px 0px";

/**
 * Whether the element has come within a screen of the viewport, once (§20).
 *
 * For a query that should wait until somebody could see its answer: a performer's "Appears
 * with", a saved view's face. An effect because an observer is a subscription to the page, not
 * a fetch: it only flips the state that enables the query, and TanStack does the asking.
 * Sticky, so scrolling back up does not disable a query that has already answered. Without
 * `IntersectionObserver` it is simply near.
 */
export const useNearViewport = <T extends Element>() => {
    const ref = useRef<T>(null);
    const [near, setNear] = useState(false);

    useEffect(() => {
        const node = ref.current;

        if (near || !node) {
            return;
        }

        if (typeof IntersectionObserver === "undefined") {
            setNear(true);

            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNear(true);
                }
            },
            { rootMargin: NEAR_MARGIN }
        );

        observer.observe(node);

        return () => observer.disconnect();
    }, [near]);

    return { ref, near };
};
