import { effectiveSort, parseView, viewToRequestParams } from "@/lib/libraryQuery";
import { parsePlaylistView, playlistHref } from "@/lib/playlistView";

/**
 * What the showcase is showing, stated once (§14f).
 *
 * Two readers must agree on it exactly: the showcase, which fetches the set, and the viewer,
 * which steps through the same set after a tile is opened — and warms whatever comes next.
 * The viewer used to read a showcase address as a library one, which asked a different
 * question: images included, and pages of sixty where the showcase had fetched two hundred.
 */

export const SHOWCASE_PATH = "/showcase";

/**
 * The tasting (§14g), which walks exactly the showcase's set: the same filter, the same pages
 * of two hundred, the same cache keys. One item at a time instead of a wall, but the viewer
 * opened from either is in the same set and asks the same question.
 */
export const TASTING_PATH = "/tasting";

/** Whether an address is one of the two modes that walk this set. */
export const walksShowcaseSet = (path: string): boolean =>
    path === SHOWCASE_PATH || path === TASTING_PATH;

/**
 * Items per page. The API's ceiling, and deliberately large: a page is laid out in one pass
 * and is thousands of pixels tall, so a fetch buys minutes of drift.
 */
export const SHOWCASE_PAGE_SIZE = 200;

/**
 * The request for a showcase address: the library's filter and sort, no paging.
 *
 * Exactly the grid's set, kind included. It used to force videos, on the theory that a still
 * has no clip to play; but someone browsing Images who opened the showcase got a wall of
 * videos they had just filtered away. A still shows its cover, which is what a tile shows
 * until a decoder is granted anyway.
 */
export const showcaseFilter = (address: URLSearchParams): string => {
    const view = parseView(address);

    return viewToRequestParams({ ...view, sort: effectiveSort(view) }).toString();
};

/**
 * The filter as it appears in a page's query key.
 *
 * The limit is part of it: a page of two hundred is not the grid's page of sixty with the same
 * number, and must never be served in its place.
 */
export const showcasePageKey = (filter: string): string => {
    const params = new URLSearchParams(filter);

    params.set("limit", String(SHOWCASE_PAGE_SIZE));

    return params.toString();
};

/**
 * A set the two modes can walk: a library filter, or a playlist in one of its orders.
 *
 * A playlist is not a query, so it cannot be spelled as a filter; it is carried as
 * `playlist=<id>` beside the playlist's own order parameters, and walked in the playlist's own
 * pages under the playlist page's own keys -- so the viewer opened from it, and the playlist
 * page behind it, find those pages already cached.
 */
export type ShowcaseSet =
    | { kind: "library"; filter: string }
    | { kind: "playlist"; playlistId: string; seed: number | null };

/** The set a showcase or tasting address names. */
export const showcaseSet = (address: URLSearchParams): ShowcaseSet => {
    const playlistId = address.get("playlist");

    if (playlistId) {
        return { kind: "playlist", playlistId, seed: parsePlaylistView(address).seed };
    }

    return { kind: "library", filter: showcaseFilter(address) };
};

/**
 * The set as one string: what a mode resets on and what a remembered position belongs to.
 *
 * A library set is its filter, as it always was, so a position saved before playlists could
 * be shown still applies.
 */
export const showcaseSetKey = (set: ShowcaseSet): string =>
    set.kind === "library"
        ? set.filter
        : `playlist:${set.playlistId}:${set.seed === null ? "stored" : set.seed}`;

/** The address parameters that open a playlist, in this order, as a showcase or tasting. */
export const playlistSetParams = (playlistId: string, seed: number | null): URLSearchParams => {
    const params = new URLSearchParams({ playlist: playlistId });

    if (seed === null) {
        params.set("order", "stored");
    } else {
        params.set("seed", String(seed));
    }

    return params;
};

/** Where closing a mode goes when nothing is behind it: the page the set came from. */
export const showcaseOriginHref = (address: URLSearchParams): string => {
    const set = showcaseSet(address);

    if (set.kind === "playlist") {
        return playlistHref(set.playlistId, {
            page: 0,
            seed: set.seed,
            decided: true,
            mode: "grid",
        });
    }

    return `/?${address.toString()}`;
};

/** The page a showcase or tasting address records for the viewer, in the set's own pages. */
export const showcaseAddressPage = (address: URLSearchParams): number =>
    address.get("playlist") ? parsePlaylistView(address).page : parseView(address).page;
