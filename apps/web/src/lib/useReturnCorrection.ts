"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { takeReturnCorrection } from "./returnTo";

/**
 * Arriving back from the viewer: move to the page the viewer had reached (§14b).
 *
 * The viewer goes back with `history.back()`, which restores this page as it was left, and
 * leaves behind the address it had stepped on to. When the two differ — you opened page 2 and
 * stepped through to page 4 — this replaces the address, so the list shows the page holding
 * the item you were last looking at, and the history still holds one entry for the list.
 *
 * For every page the viewer can be opened from with a set behind it: the library and a
 * playlist. The showcase has its own way of coming back (`lib/showcase/restore`).
 */
export const useReturnCorrection = (): void => {
    const router = useRouter();

    useEffect(() => {
        const correction = takeReturnCorrection(window.location.pathname + window.location.search);

        if (correction) {
            router.replace(correction);
        }
    }, [router]);
};
