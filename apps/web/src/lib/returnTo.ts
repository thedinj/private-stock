/**
 * Where the viewer came from, so an item can put them back (§14).
 *
 * Opening an item is a detour: you were on page 34 of a filtered library, scrolled halfway
 * down, and you want that back rather than the front door. A link to `/` cannot do it — the
 * page, the filter and the scroll position are all lost — so the player asks the browser to
 * go back instead, which restores all three for free.
 *
 * What the browser cannot tell us is whether there *is* anywhere to go back to. `history.back()`
 * on a tab whose first page was the item leaves the app entirely, and `history.length` counts
 * entries from before this site was opened. So the grid records the address it is sending you
 * from, in `sessionStorage`:
 *
 *   - present  → this tab navigated here from a library view; `back()` is safe and correct.
 *   - absent   → a shared link, a new tab, a bookmark. Offer the room instead.
 *
 * Per tab rather than per browser, which is what `sessionStorage` gives: two tabs open on two
 * different libraries each get their own answer.
 */

import { z } from "zod";

import { mediaListItemSchema, type MediaListItem } from "@private-stock/core";

const KEY = "ps:returnTo";
const SHELF_KEY = "ps:returnShelf";

/** Called as an item is opened, by whatever is doing the opening. */
export const rememberReturn = (): void =>
    rememberReturnTo(window.location.pathname + window.location.search);

/**
 * The same, for an opener whose set is not fully described by its own address.
 *
 * The showcase is one: its address holds the filter but not where in it you were, and the
 * viewer needs the page to find its neighbours (§14f).
 *
 * Every recording clears the shelf a previous one may have left, so a snapshot can only ever
 * describe the opening that wrote it.
 */
export const rememberReturnTo = (href: string): void => {
    recordedHere = true;

    try {
        sessionStorage.setItem(KEY, href);
        sessionStorage.removeItem(SHELF_KEY);
    } catch {
        // Private mode, or storage disabled. The back link falls back to the room, which is
        // never wrong — only less helpful.
    }
};

/**
 * A room shelf, as the set to walk (§14b).
 *
 * A shelf is not a query the grid can express — "recently viewed" is an ordering over one
 * viewer's views — so its address cannot describe it. The items are recorded instead, exactly as
 * the shelf showed them. A snapshot rather than a re-read of the room: watching the first item
 * of "recently viewed" moves it, and a set recomputed at every step would send the viewer
 * back to where it had just been.
 */
export const rememberShelf = (items: MediaListItem[]): void => {
    const href = window.location.pathname + window.location.search;

    rememberReturnTo(href);

    try {
        sessionStorage.setItem(SHELF_KEY, JSON.stringify({ href, items }));
    } catch {
        // The item still opens, and Back still works; it simply stands alone.
    }
};

const shelfSnapshotSchema = z.object({
    href: z.string(),
    items: z.array(mediaListItemSchema),
});

/**
 * The shelf recorded with `returnTo`, or null when the opening recorded none.
 *
 * Matched against the address as well, so a snapshot can never be read against an address it
 * was not written with.
 */
export const readShelf = (returnTo: string): MediaListItem[] | null => {
    try {
        const raw = sessionStorage.getItem(SHELF_KEY);
        const parsed = raw ? shelfSnapshotSchema.safeParse(JSON.parse(raw)) : null;

        return parsed?.success && parsed.data.href === returnTo ? parsed.data.items : null;
    } catch {
        return null;
    }
};

/**
 * Whether this page load recorded an address itself.
 *
 * `sessionStorage` outlives the visit that wrote it. An item URL pasted into a tab that
 * browsed the library an hour ago, or opened in a new tab — which copies the opener's storage
 * — would otherwise find an address nobody came from, and offer "Back to library" into
 * whatever the history happens to hold.
 */
let recordedHere = false;

/**
 * This document was opened fresh: typed, pasted, bookmarked, a new tab, an outside link.
 *
 * Not a reload and not a trip through the history, both of which keep the history the address
 * describes — reloading the viewer, or coming back to it, still has the list behind it.
 */
const openedFresh = (): boolean => {
    const entry = performance.getEntriesByType?.("navigation")[0] as
        PerformanceNavigationTiming | undefined;

    return entry?.type === "navigate";
};

/** The address this tab arrived from, or null if it did not arrive from one. */
export const readReturn = (): string | null => {
    try {
        if (!recordedHere && openedFresh()) {
            sessionStorage.removeItem(KEY);

            return null;
        }

        return sessionStorage.getItem(KEY);
    } catch {
        return null;
    }
};

/**
 * What to call the place we would be going back to.
 *
 * Read from the address rather than stored alongside it, so it cannot disagree with where the
 * link actually goes.
 */
export const returnLabel = (href: string | null): string => {
    if (!href) return "Home";

    // Read from the path, which is the only thing that distinguishes a playlist from a
    // library view -- both carry a page and possibly a seed.
    const path = pathOf(href);

    if (path.startsWith("/playlists/")) return "the playlist";
    // Before the query checks: a showcase carries the library's filter, `view` included.
    if (path === "/showcase") return "the showcase";
    if (path === "/tasting") return "the tasting";
    if (path === "/review/duplicates") return "duplicates";
    if (path === "/review/ocr") return "OCR review";
    if (path === "/review/faces") return "face review";
    if (path === "/clips") return "clips";
    if (path === "/captures") return "captures";
    if (path === "/tags/performers") return "performers";
    if (path === "/tags/sources") return "sources";
    if (path === "/tags/keywords") return "keywords";
    if (path !== "/") return "the previous page";

    const query = href.includes("?") ? new URLSearchParams(href.slice(href.indexOf("?"))) : null;

    if (query?.get("search")) return "search results";
    if (query?.get("root")) return "library";
    if (query?.get("view")) return "library";

    return "Home";
};

export const pathOf = (href: string): string => href.split("?")[0] ?? href;

/**
 * The same address, at another page of its set.
 *
 * Stepping through the viewer crosses page boundaries — the item after the sixtieth is on the
 * next page — and the address is what both the viewer's idea of "next" and the way back are
 * read from, so it has to move with you (§14b). Page 0 is written as no page at all, the way
 * the library writes its own addresses, so a round trip does not change an address that
 * never left the first page.
 */
export const returnAtPage = (href: string, page: number): string => {
    const query = new URLSearchParams(href.includes("?") ? href.slice(href.indexOf("?")) : "");

    if (page > 0) {
        query.set("page", String(page));
    } else {
        query.delete("page");
    }

    const search = query.toString();

    return search ? `${pathOf(href)}?${search}` : pathOf(href);
};

const CORRECTION_KEY = "ps:returnCorrection";

/**
 * Back is `history.back()`, which restores the list exactly as it was left — scroll and all.
 * But "as it was left" is the page the viewer was *opened* from, and stepping through may have
 * carried you several pages on. So the viewer leaves the address it has reached here, and the
 * page that receives the back navigation replaces its own address with it on arrival.
 *
 * A replace rather than a push, so the history ends where it began: one entry for the list.
 */
export const requestReturnCorrection = (href: string): void => {
    try {
        sessionStorage.setItem(CORRECTION_KEY, href);
    } catch {
        // Back still works; it lands on the page the viewer was opened from.
    }
};

/**
 * Called by a list page as it mounts. Returns the address to replace its own with, or null.
 *
 * Consumed whether or not it applies: a correction meant for one page must not be picked up
 * by a different one later. It applies only to the same path — the back navigation might not
 * have landed where the viewer expected, and a library address is no correction for a playlist.
 */
export const takeReturnCorrection = (current: string): string | null => {
    let href: string | null = null;

    try {
        href = sessionStorage.getItem(CORRECTION_KEY);
        sessionStorage.removeItem(CORRECTION_KEY);
    } catch {
        return null;
    }

    if (!href || href === current || pathOf(href) !== pathOf(current)) {
        return null;
    }

    return href;
};
