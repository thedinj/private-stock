import {
    COVER_CLEARED_CHANGE,
    type HomeResponse,
    type MediaListItem,
    type MediaListResponse,
} from "@private-stock/core";

/**
 * Patching one item into the lists that are already on screen (§13b).
 *
 * A cover appearing is the single most visible sign the app is working, and it moves nothing:
 * the item is already in the grid, in its place, showing "processing…". So it is patched where
 * it stands rather than triggering a refetch of the page it is on.
 *
 * This is a separate, tested module because the previous version was written against a cache
 * shape the app does not have. It patched `InfiniteData<MediaListResponse>` — `data.pages.map`
 * — over the prefix `["media"]`, and the grid has never been an infinite query: it caches one
 * `MediaListResponse` per page under `["media", "list", filter, page]`, and that same prefix
 * also matches `["media", <id>]`, which holds a single item's details. So the updater threw on
 * the first artifact event it saw, and **no cover has ever patched into an open grid**. The
 * failure was invisible in exactly the way stale data always is: a tile that says "processing…"
 * looks the same whether the app is waiting or has stopped listening.
 *
 * Every function here returns **the value it was given** when the item is not in it. Returning
 * a fresh object would re-render the whole grid for an item it is not showing, and there is one
 * of these calls per page in the cache.
 */

/** What a finished artifact can change about a tile. Nothing else is patchable from an event. */
export interface ItemPatch {
    /** Null draws the placeholder: the item has no cover any more. */
    coverUrl?: string | null;
    previewUrl?: string;
}

/**
 * What an artifact event changes about a tile, or null when it changes nothing a list draws.
 *
 * **Which URL depends on which artifact.** They are not interchangeable: an item can have a
 * preview before it has a cover, and writing a cover URL because a preview finished points a
 * tile at a file that does not exist. The same holds in reverse for a cover that went away —
 * discarding the capture that was the cover of an item with no generated one (§9) — where the
 * cover alias would answer 404 and the tile would draw a broken image.
 *
 * The event does not carry the canonical version token, so the change id stands in as one. It
 * only has to differ from what the browser already cached: the art route serves an
 * unrecognised token correctly, just with a short cache lifetime.
 */
export const artifactPatch = (
    mediaId: string,
    kind: string | null,
    version: number
): ItemPatch | null => {
    switch (kind) {
        case "cover":
            return { coverUrl: `/api/art/${mediaId}/cover?v=${version}` };
        case COVER_CLEARED_CHANGE:
            return { coverUrl: null };
        case "preview":
            return { previewUrl: `/api/art/${mediaId}/preview?v=${version}` };
        default:
            return null;
    }
};

export const patchItems = (
    items: readonly MediaListItem[],
    mediaId: string,
    patch: ItemPatch
): readonly MediaListItem[] =>
    items.some((item) => item.id === mediaId)
        ? items.map((item) => (item.id === mediaId ? { ...item, ...patch } : item))
        : items;

/** One page of the grid, as `LibraryCellar` and the viewer's prefetch both cache it. */
export const patchListPage = (
    page: MediaListResponse | undefined,
    mediaId: string,
    patch: ItemPatch
): MediaListResponse | undefined => {
    if (!page) return page;

    const items = patchItems(page.items, mediaId, patch);

    return items === page.items ? page : { ...page, items: [...items] };
};

/**
 * A page of the grid brought up to date without changing its order (§13b, §14b).
 *
 * `fresh` is what the server now says about the items on the page (`/api/media/lookup`): each
 * item is replaced by its fresh copy where it stands, and one the server no longer returns --
 * trashed, missing, hidden -- is dropped, so everything after it moves up one. Nothing is
 * added: new items wait for the grid's "Show N new items".
 */
export const refreshListPage = (
    page: MediaListResponse | undefined,
    fresh: MediaListItem[]
): MediaListResponse | undefined => {
    if (!page) return page;

    const byId = new Map(fresh.map((entry) => [entry.id, entry]));

    return {
        ...page,
        items: page.items.flatMap((entry) => {
            const current = byId.get(entry.id);

            return current ? [current] : [];
        }),
    };
};

/**
 * The room, whose shelves hold the same items under an entirely different shape.
 *
 * Patched here rather than left to a refetch because the room is the front door: it is where a
 * newly added item is most likely to be sitting when its cover is made, and a refetch there
 * would re-resolve every shelf — including shelves whose order would then change under the
 * cursor, which is the one thing §13b exists to prevent.
 */
export const patchShelves = (
    home: HomeResponse | undefined,
    mediaId: string,
    patch: ItemPatch
): HomeResponse | undefined => {
    if (!home) return home;

    let changed = false;

    const shelves = home.shelves.map((shelf) => {
        const items = patchItems(shelf.items, mediaId, patch);

        if (items === shelf.items) return shelf;

        changed = true;

        return { ...shelf, items: [...items] };
    });

    return changed ? { ...home, shelves } : home;
};
