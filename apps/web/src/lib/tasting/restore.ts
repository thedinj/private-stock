/**
 * Where the tasting was, so coming back to it lands there (§14g).
 *
 * Written by the tasting as an item is opened in the viewer, and again by the viewer on the
 * way back: by then the viewer may have stepped several items on, and the tasting should carry
 * on from the item you were last looking at rather than the one you opened.
 *
 * Read without being consumed, so a remount -- React's development double-mount among them --
 * finds the same answer twice. Forgotten when the tasting is entered from the library, which is
 * a request to start at the beginning.
 */

const KEY = "ps:tasting";

export interface TastingPosition {
    /** The tasting's filter it applies to; any other tasting ignores it. */
    filter: string;
    page: number;
    itemId: string;
}

export const saveTastingPosition = (position: TastingPosition): void => {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(position));
    } catch {
        // Private mode: coming back starts from the beginning, which is only less helpful.
    }
};

export const readTastingPosition = (filter: string): TastingPosition | null => {
    try {
        const raw = sessionStorage.getItem(KEY);
        const saved = raw ? (JSON.parse(raw) as TastingPosition) : null;

        return saved?.filter === filter ? saved : null;
    } catch {
        return null;
    }
};

export const forgetTastingPosition = (): void => {
    try {
        sessionStorage.removeItem(KEY);
    } catch {
        // Nothing stored, then.
    }
};
