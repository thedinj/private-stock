"use client";

import { useEffect } from "react";

/**
 * Closes the door behind you (§14).
 *
 * The library is the cellar — racks, hunting, a hundred thousand things. The viewer is the
 * next room along: you sit down with one of them. Marking the room on the document rather
 * than styling the page lets the *shell* recede too, which is the part that makes it read as
 * a different room instead of a differently painted page: the header loses its edge, the nav
 * drops back, and the firelight that plays across the cellar goes out, because in here the
 * only light is the screen.
 *
 * An attribute on `<html>`, so it is one flag driving token overrides in `globals.scss`
 * rather than a prop threaded through the shell — and so nothing re-renders to change rooms.
 * The tokens carry a transition, which is why the two rooms feel adjacent rather than
 * swapped.
 *
 * Removed on unmount, including when the viewer navigates straight to another item: React
 * keeps the page mounted across that, so the flag stays set and the room never flickers.
 */
export const useStudyRoom = (): void => {
    useEffect(() => {
        const root = document.documentElement;

        root.dataset.room = "study";

        return () => {
            delete root.dataset.room;
        };
    }, []);
};
