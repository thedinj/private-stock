"use client";

import { useEffect, useRef, useState } from "react";

import { previewsAllowed, releasePreviewSlot, requestPreviewSlot } from "./previewBudget";

/**
 * React binding for the preview budget.
 *
 * `want` says this tile would like to play — because it is hovered, or because it is visible
 * in gallery mode. The returned value says whether it may, which is a different question and
 * the one the tile must actually obey.
 */
export const usePreviewSlot = (want: boolean, priority: number): boolean => {
    // The token identifies this component instance to the budget. An object rather than a
    // string, so two tiles showing the same media never collide.
    const token = useRef({}).current;
    const [granted, setGranted] = useState(false);

    useEffect(() => {
        if (!want || !previewsAllowed()) {
            releasePreviewSlot(token);
            setGranted(false);
            return;
        }

        requestPreviewSlot(token, priority, setGranted);

        // Releasing on unmount is what stops a scrolled-away tile holding a decoder. The
        // virtualizer unmounts rows aggressively, so this runs constantly and must be cheap.
        return () => {
            releasePreviewSlot(token);
        };
    }, [want, priority, token]);

    return granted;
};
