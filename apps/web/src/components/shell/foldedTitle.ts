import { useSyncExternalStore } from "react";

/**
 * The plate title folded into the header (§14, "Motion").
 *
 * One plate per screen, so one slot: the plate writes its title here while it is scrolled out
 * from under the header and clears it when it comes back or goes away, and the header reads it.
 * A module-level store rather than a context because the two are in different branches of the
 * tree -- the plate is deep in a page, the header is in the shell -- and nothing else needs it.
 */

let folded: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

export const setFoldedTitle = (title: string | null): void => {
    if (title === folded) return;

    folded = title;
    listeners.forEach((listener) => listener());
};

/** The title to show in the header, or null while the plate itself is on screen. */
export const useFoldedTitle = (): string | null =>
    useSyncExternalStore(
        subscribe,
        () => folded,
        () => null
    );
