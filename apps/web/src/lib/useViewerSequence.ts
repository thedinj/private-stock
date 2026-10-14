"use client";

import { useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type {
    MediaCountResponse,
    MediaIdsResponse,
    MediaListItem,
    MediaListResponse,
    MediaLookupResponse,
} from "@private-stock/core";

import { BACKGROUND } from "./api/background";
import { api } from "./api/client";
import { PAGE_SIZE, effectiveSort, parseView, viewToRequestParams } from "./libraryQuery";
import { parsePlaylistView, playlistIdFromPath } from "./playlistView";
import { pathOf, readShelf } from "./returnTo";
import {
    adjacentPagesNeeded,
    neighbours,
    pageOfId,
    pickHeldPage,
    upcomingIds,
    type Neighbours,
} from "./viewerSequence";
import { queryKeys } from "@/lib/api/queryKeys";
import {
    SHOWCASE_PAGE_SIZE,
    walksShowcaseSet,
    showcaseAddressPage,
    showcasePageKey,
    showcaseSet,
} from "@/lib/showcase/set";

/**
 * Prev and next through the set the viewer arrived from (§14b).
 *
 * The address the grid was left at is already recorded for the back link, so the set is
 * known: parse it, and ask the same question the grid asked. The query keys are built to
 * match the grid's exactly — so arriving from the library or from a playlist is a cache hit,
 * not a second trip for an answer the browser already has.
 *
 * Two kinds of set, and the arithmetic over them is identical. A filtered library is a query;
 * a playlist is a list somebody arranged, in its stored order or in a shuffle of it. What
 * makes the second work without a second code path is that the order lives in the address —
 * `seed` and all — so parsing it here reproduces exactly the order the grid was showing,
 * including which shuffle.
 *
 * Nothing here works without that address. An item opened from a shared link or a new tab has
 * no set to move through, and reports none rather than inventing "the whole library", which
 * would be a different set from the one anybody was looking at.
 */

interface Sequence extends Neighbours {
    /** Total items in the set, or null while unknown or uncounted. */
    total: number | null;
    /**
     * What comes after this item, for the up-next strip.
     *
     * The ids come from the pages already held rather than a question asked for the purpose —
     * the strip is a view onto the set, not a second question about it. Short: a filmstrip is
     * a glance at what is coming, and a row long enough to scroll is a grid with extra steps.
     */
    upcomingIds: string[];
    /**
     * The same items as tiles, for drawing them. A library's pages are ids alone, so these are
     * looked up — only the ones no cache already holds — and may trail `upcomingIds` briefly.
     */
    upcoming: MediaListItem[];
    /** The page of the set this item is on, or null when there is no set. */
    page: number | null;
    /**
     * Which page of the set an id is on, among the pages held — for the viewer to carry its
     * recorded address along as it steps, so the set is never lost at a page boundary.
     */
    pageOf: (id: string) => number | null;
    /**
     * Where an item matched the set's look, in ms, among the pages held; null for any other set
     * (§5e). Stepping through a look's set opens each item at its match, as its tile does.
     */
    momentOf: (id: string) => number | null;
}

/** How many items the up-next strip shows. */
const UPCOMING = 8;

const EMPTY: Sequence = {
    previousId: null,
    nextId: null,
    position: null,
    total: null,
    upcomingIds: [],
    upcoming: [],
    page: null,
    pageOf: () => null,
    momentOf: () => null,
};

/**
 * The set behind the viewer: a library query, or a playlist in one of its orders.
 *
 * `page` is where the viewer was standing. The rest is what identifies the set itself, and is
 * what the query keys are built from.
 */
type ViewerSet =
    | {
          kind: "library";
          filterParams: string;
          page: number;
          /** Sixty from the grid; two hundred from the showcase, which pages its own way. */
          pageSize: number;
          /** The filter as the page's cache key spells it — the opener's key, exactly. */
          keyFilter: string;
      }
    | { kind: "playlist"; playlistId: string; seed: number | null; page: number }
    /**
     * A room shelf: the items it showed, recorded as it was opened. One page, never fetched —
     * the set is the snapshot, and there is nothing after its last item.
     */
    | { kind: "shelf"; items: MediaListItem[]; page: 0 };

/**
 * One page of whichever set this is, as the server answered it.
 *
 * A library page is ids alone (`/api/media/ids`). A playlist page is tiles, under the playlist
 * page's own key — that cache is shared, so what is stored there has to be exactly what the
 * playlist page stores — and only it carries a `total`, because a playlist can afford to count
 * and a filtered library cannot (§20).
 */
type RawPage =
    | Pick<MediaIdsResponse, "ids" | "hasMore" | "moments">
    | { items: MediaListItem[]; total?: number; hasMore: boolean };

/** One page as the viewer holds it, whichever kind of set it came from. */
interface HeldPage {
    ids: string[];
    /** Whether another page follows. The only reliable end marker; see `adjacentPagesNeeded`. */
    hasMore: boolean;
    /** Tiles, when the answer carried them: a playlist's page, or a shelf. */
    items?: MediaListItem[];
    total?: number;
    /** A look's matching moments, by id (§5e). */
    moments?: Record<string, number>;
}

/** Module-level, so `select` keeps one identity and is not rerun every render. */
const toHeld = (raw: RawPage): HeldPage =>
    "ids" in raw
        ? { ids: raw.ids, hasMore: raw.hasMore, moments: raw.moments }
        : {
              ids: raw.items.map((item) => item.id),
              hasMore: raw.hasMore,
              items: raw.items,
              total: raw.total,
          };

/**
 * Annotated rather than inferred: the two branches return different key tuples, and the union
 * of them defeats the query hook's own inference of what the page contains.
 */
interface PageQuery {
    queryKey: readonly unknown[];
    queryFn: () => Promise<RawPage>;
    staleTime?: number;
    initialData?: () => RawPage | undefined;
    initialDataUpdatedAt?: () => number | undefined;
}

const pageQuery = (set: ViewerSet | null, page: number, queryClient: QueryClient): PageQuery => {
    if (set?.kind === "playlist") {
        const params = new URLSearchParams({ page: String(page) });

        if (set.seed !== null) params.set("seed", String(set.seed));

        return {
            // Identical in shape to the playlist page's own. See lib/api/playlists.
            queryKey: queryKeys.playlists.itemsPage(set.playlistId, page, set.seed),
            queryFn: () =>
                api<RawPage>(`/api/playlists/${set.playlistId}/items?${params.toString()}`),
        };
    }

    const filterParams = set?.kind === "library" ? set.filterParams : "";
    const pageSize = set?.kind === "library" ? set.pageSize : PAGE_SIZE;
    const keyFilter = set?.kind === "library" ? set.keyFilter : "";
    const gridKey = queryKeys.media.page(keyFilter, page);

    return {
        /**
         * Ids alone (§20). The viewer draws one item at a time and fetches it on its own; all it
         * needs of the set is the order. Asking for the grid's tiles instead hydrated two hundred
         * of them -- about five cold pages each -- on every step through a showcase-sized set.
         */
        queryKey: queryKeys.media.idsPage(keyFilter, page),
        queryFn: async () => {
            const params = new URLSearchParams(filterParams);

            params.set("limit", String(pageSize));
            params.set("page", String(page));

            const { ids, hasMore, moments } = await api<MediaIdsResponse>(
                `/api/media/ids?${params.toString()}`
            );

            return { ids, hasMore, moments };
        },
        /**
         * Asked again on every arrival, because it is cheap now and the offsets depend on it.
         *
         * Working through "Untagged" tags each item out of the set as it goes, and every item
         * that leaves moves everything after it one place earlier. A page held from several
         * items ago would put the next page's offset past items that have since slid onto this
         * one, and the walk would skip them. Read fresh at each step, the page the viewer holds
         * is at most the one step old that `pickHeldPage` needs it to be.
         */
        staleTime: 0,
        /**
         * The grid's or the showcase's page of the same set, if it is cached — arriving from
         * either is then instant, as it was when the viewer read the grid's tiles directly.
         */
        initialData: () => {
            const grid = queryClient.getQueryData<MediaListResponse>(gridKey);

            return (
                grid && {
                    ids: grid.items.map((item) => item.id),
                    hasMore: grid.hasMore,
                    moments:
                        grid.moments &&
                        Object.fromEntries(
                            Object.entries(grid.moments).map(([id, moment]) => [id, moment.atMs])
                        ),
                }
            );
        },
        initialDataUpdatedAt: () => queryClient.getQueryState(gridKey)?.dataUpdatedAt,
    };
};

/**
 * Pages held for earlier items, by query key, for `pickHeldPage`'s fallback.
 *
 * Module-level because stepping remounts the viewer (§14b): the page held for the item before
 * this one is gone with that instance, and it is the only record of where an item that has
 * since left the set used to stand. A handful is plenty — the fallback is only ever about the
 * last few steps.
 */
const REMEMBERED = 16;
const remembered = new Map<string, HeldPage>();

const remember = (key: readonly unknown[], held: HeldPage): void => {
    const id = JSON.stringify(key);

    remembered.delete(id);
    remembered.set(id, held);

    if (remembered.size > REMEMBERED) {
        const oldest = remembered.keys().next().value;

        if (oldest !== undefined) remembered.delete(oldest);
    }
};

/**
 * Tiles the browser already holds for these ids: any cached page of the library or the
 * showcase, and any earlier up-next lookup.
 *
 * Read from the cache rather than asked for again, because the strip slides one item per step:
 * seven of its eight tiles were drawn a moment ago, and only the one that has just come into
 * view is worth a request.
 */
const cachedTiles = (queryClient: QueryClient, ids: string[]): Map<string, MediaListItem> => {
    const wanted = new Set(ids);
    const found = new Map<string, MediaListItem>();

    const take = (items: MediaListItem[] | undefined): void => {
        for (const item of items ?? []) {
            if (wanted.has(item.id)) found.set(item.id, item);
        }
    };

    for (const [, data] of queryClient.getQueriesData<MediaListResponse>({
        queryKey: queryKeys.media.list(),
    })) {
        take(data?.items);
    }

    for (const [, data] of queryClient.getQueriesData<MediaLookupResponse>({
        queryKey: queryKeys.media.lookups(),
    })) {
        take(data?.items);
    }

    return found;
};

/**
 * The address the viewer came from, as a set.
 *
 * A playlist address is recognised by its path; everything else is read as a library query,
 * which is what every other address on this app is.
 */
const parseSet = (returnTo: string): ViewerSet | null => {
    const shelf = readShelf(returnTo);

    if (shelf) {
        return { kind: "shelf", items: shelf, page: 0 };
    }

    const query = new URLSearchParams(
        returnTo.includes("?") ? returnTo.slice(returnTo.indexOf("?")) : ""
    );
    const playlistId = playlistIdFromPath(returnTo);

    if (playlistId) {
        const view = parsePlaylistView(query);

        return { kind: "playlist", playlistId, seed: view.seed, page: view.page };
    }

    /**
     * The showcase or the tasting: the library's filter, in pages of two hundred (§14f, §14g).
     *
     * Read as a library address it would be a different set — a page number counted in
     * sixties — and the item after this one would be the wrong one, or nothing at all.
     */
    if (walksShowcaseSet(pathOf(returnTo))) {
        const set = showcaseSet(query);
        const page = showcaseAddressPage(query);

        // A playlist shown full screen is walked in the playlist's own pages, as it was shown.
        if (set.kind === "playlist") {
            return { kind: "playlist", playlistId: set.playlistId, seed: set.seed, page };
        }

        const filterParams = set.filter;

        return {
            kind: "library",
            filterParams,
            page,
            pageSize: SHOWCASE_PAGE_SIZE,
            keyFilter: showcasePageKey(filterParams),
        };
    }

    /**
     * Only the library is a query. The room — `/` with no query — has no order and no pages
     * beyond the shelf it was opened from, read above; and every other address (duplicates, clips, another item) is somewhere the viewer can
     * go back to but not a set it can walk: reading its query as a library filter would walk
     * a set nobody was looking at.
     */
    if (pathOf(returnTo) !== "/" || !returnTo.includes("?")) {
        return null;
    }

    const view = parseView(query);
    const filterParams = viewToRequestParams({ ...view, sort: effectiveSort(view) }).toString();

    return {
        kind: "library",
        filterParams,
        page: view.page,
        pageSize: PAGE_SIZE,
        keyFilter: filterParams,
    };
};

export const useViewerSequence = (returnTo: string | null, currentId: string): Sequence => {
    const queryClient = useQueryClient();

    /**
     * The set, read once from the address the grid was left at.
     *
     * Held in a ref rather than derived each render so that a `returnTo` which somehow
     * changed — it cannot today, being read once itself — could not move the viewer to a
     * different set while they are standing in it.
     */
    const parsed = useRef<ViewerSet | null>(null);

    if (parsed.current === null && returnTo) {
        parsed.current = parseSet(returnTo);
    }

    const set = parsed.current;
    const enabled = set !== null;
    const page = set?.page ?? 0;

    const shelfItems = set?.kind === "shelf" ? set.items : undefined;
    const fetched = enabled && !shelfItems;

    /**
     * The pages this item stands in, held from the first good answer and kept.
     *
     * The set is what it was when the viewer arrived at this item, and it must not be
     * recomputed underneath them. Rating the item you are looking at while inside "Unrated
     * only" invalidates the list it came from — deliberately, so the grid is right when you go
     * back — and the refetched page no longer contains this item. Recomputing there would
     * delete the next button mid-browse, as a consequence of an unrelated click.
     *
     * Keyed by the item, so a step that did not remount would still hold afresh.
     */
    const held = useRef<{ id: string; current?: HeldPage; previous?: HeldPage; next?: HeldPage }>({
        id: currentId,
    });

    if (held.current.id !== currentId) {
        held.current = { id: currentId };
    }

    const hold = held.current;

    const currentPage = pageQuery(set, page, queryClient);
    const current = useQuery({
        ...currentPage,
        select: toHeld,
        enabled: fetched,
        meta: BACKGROUND,
    });

    if (!hold.current && enabled) {
        const picked = shelfItems
            ? toHeld({ items: shelfItems, hasMore: false })
            : pickHeldPage(
                  current.data,
                  current.data !== undefined && !current.isFetching,
                  remembered.get(JSON.stringify(currentPage.queryKey)),
                  currentId
              );

        if (picked) {
            hold.current = picked;

            if (!shelfItems) remember(currentPage.queryKey, picked);
        }
    }

    const pageSize = set?.kind === "library" ? set.pageSize : PAGE_SIZE;

    const needed = hold.current
        ? adjacentPagesNeeded(hold.current.ids, page, currentId, hold.current.hasMore)
        : { previous: false, next: false };

    const previousPage = pageQuery(set, page - 1, queryClient);
    const previous = useQuery({
        ...previousPage,
        select: toHeld,
        enabled: fetched && needed.previous,
        meta: BACKGROUND,
    });

    const nextPage = pageQuery(set, page + 1, queryClient);
    const next = useQuery({
        ...nextPage,
        select: toHeld,
        enabled: fetched && needed.next,
        meta: BACKGROUND,
    });

    /**
     * An adjacent page is held once it has been asked afresh, not from whatever the cache had:
     * an old copy of the next page counts its offset in a set that has since lost items, and
     * would start past the ones that slid onto this page.
     */
    if (!hold.previous && needed.previous && previous.data && !previous.isFetching) {
        hold.previous = previous.data;
        remember(previousPage.queryKey, previous.data);
    }

    if (!hold.next && needed.next && next.data && !next.isFetching) {
        hold.next = next.data;
        remember(nextPage.queryKey, next.data);
    }

    /**
     * The total, for "23 of 312".
     *
     * A library asks for it separately, under the same key and staleness the grid's own count
     * uses, so walking into the viewer and back out does not pay for the scan twice. Shuffled
     * libraries included: a shuffle orders the matching set like any other sort (§20).
     *
     * A playlist needs none of this: its page already carries the total, because counting one
     * indexed list of a few hundred rows is nothing like scanning a filtered library.
     */
    const libraryFilterParams = set?.kind === "library" ? set.filterParams : "";

    const count = useQuery({
        queryKey: queryKeys.media.count(libraryFilterParams),
        queryFn: () => api<MediaCountResponse>(`/api/media/count?${libraryFilterParams}`),
        enabled: enabled && set?.kind === "library",
        staleTime: 60_000,
        meta: BACKGROUND,
    });

    const pageIds = hold.current?.ids ?? [];
    const inPage = new Set(pageIds);

    /**
     * An adjacent page read after items moved can overlap this one — an item that arrived
     * pushes the last of this page onto the next — and stepping onto an id already behind or
     * ahead of you here would walk in a circle.
     */
    const previousPageIds = hold.previous?.ids.filter((id) => !inPage.has(id));
    const nextPageIds = hold.next?.ids.filter((id) => !inPage.has(id));

    const ahead = upcomingIds(pageIds, nextPageIds, currentId, UPCOMING);

    /**
     * The up-next tiles. A playlist's or a shelf's pages carry them; a library's are ids, so
     * whatever no cache holds is looked up — usually the one tile the strip has just slid into
     * view.
     */
    const tiles =
        set?.kind === "library"
            ? cachedTiles(queryClient, ahead)
            : new Map(
                  [...(hold.current?.items ?? []), ...(hold.next?.items ?? [])].map((item) => [
                      item.id,
                      item,
                  ])
              );
    const missing = set?.kind === "library" ? ahead.filter((id) => !tiles.has(id)) : [];

    const lookup = useQuery({
        queryKey: queryKeys.media.lookup(missing.join(",")),
        queryFn: () => api<MediaLookupResponse>(`/api/media/lookup?ids=${missing.join(",")}`),
        enabled: missing.length > 0,
        meta: BACKGROUND,
    });

    for (const item of lookup.data?.items ?? []) {
        tiles.set(item.id, item);
    }

    if (!enabled || !hold.current) {
        return EMPTY;
    }

    const pages = { pageIds, page, previousPageIds, nextPageIds };
    const near = neighbours({ ...pages, currentId, pageSize });
    const total =
        set.kind === "library" ? (count.data?.total ?? null) : (hold.current.total ?? null);

    return {
        ...near,
        /**
         * Never past the total. A kept order (§20) keeps the slots of items tagged out of the
         * list, so a position counted in slots can run ahead of a count that has dropped them.
         */
        position:
            near.position !== null && total !== null
                ? Math.min(near.position, Math.max(total, 1))
                : near.position,
        total,
        upcomingIds: ahead,
        upcoming: ahead
            .map((id) => tiles.get(id))
            .filter((item): item is MediaListItem => item !== undefined),
        page,
        pageOf: (id) => pageOfId(pages, id),
        momentOf: (id) =>
            hold.current?.moments?.[id] ??
            hold.next?.moments?.[id] ??
            hold.previous?.moments?.[id] ??
            null,
    };
};
