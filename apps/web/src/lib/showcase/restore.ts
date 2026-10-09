/**
 * Where the showcase was, so coming back to it lands there (§14f).
 *
 * Written by the showcase as a tile is opened, and again by the viewer on the way back: by
 * then the viewer may have stepped a hundred items on, and the wall should come back showing
 * the item you were last looking at rather than the one you first clicked.
 *
 * Read without being consumed, so a remount — React's development double-mount among them —
 * finds the same answer twice.
 */

const KEY = "ps:showcase";

export interface ShowcasePosition {
    /** The showcase filter it applies to; any other showcase ignores it. */
    filter: string;
    page: number;
    /** How far down the page the viewport was, as a fraction of the page's height. */
    fraction: number;
    /** Centre this item instead, once its page is laid out. Wins over `fraction`. */
    itemId?: string;
}

export const saveShowcasePosition = (position: ShowcasePosition): void => {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(position));
    } catch {
        // Private mode: coming back starts from the top, which is only less helpful.
    }
};

export const readShowcasePosition = (filter: string): ShowcasePosition | null => {
    try {
        const raw = sessionStorage.getItem(KEY);
        const saved = raw ? (JSON.parse(raw) as ShowcasePosition) : null;

        return saved?.filter === filter ? saved : null;
    } catch {
        return null;
    }
};
