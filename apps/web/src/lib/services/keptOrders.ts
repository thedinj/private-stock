import { findsUntagged, type MediaQuery } from "@private-stock/core";
import { mediaRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { createTtlCache } from "../ttlCache";
import { takeLookOrder } from "./lookService";
import { orderCacheKey } from "./queryCacheKey";

/**
 * A list's whole order, taken once and served page by page (§20 "A shuffle is sorted once").
 *
 * No index serves a shuffle, so every page of one -- and its count -- sorted the entire matching
 * set to return sixty ids: 538 pages a step for a viewer walking untagged videos on the
 * production replica, ~934 for the same filter narrowed to four stars, whatever the order. The
 * viewer asks for its page on every arrival, so a session paid that on every step. Here the
 * order is taken once, as rowids, and each page is the slice it covers with membership checked
 * again for that slice alone (`mediaRepo.stillMatching`): ~130–220 pages, and the count none.
 *
 * **Which lists.** Shuffles, and "find untagged" lists in whatever order the override gives
 * them (`withSortOverride`): there the filter rather than the order is the cost -- every sort of
 * "no performer, four stars" read the same 934 pages -- and tagging through one is exactly the
 * session that asks for page after page. And looks, whose order exists nowhere but here: it is
 * ranked in this process from vectors, not sorted by the database (`lookService`, §5e).
 *
 * **What a kept order can get wrong, and for how long.**
 * - An item that *left* the set -- tagged, rated, hidden, trashed, its library disabled -- never
 *   shows: every slice is checked again. Its slot stays, so the page it was on comes back one
 *   short and nothing after it moves. That is what the viewer's walk wants (the order does not
 *   shift under it while somebody tags), and the grid shows a short page, as it does when the
 *   live feed takes a tile out in place.
 * - An item that *arrived* -- a new file -- moves the newest rowid, which is checked on every
 *   use (one descent), and the order is taken again.
 * - An item that *joined* the set by an edit -- untagged, re-rated into it, unhidden -- is
 *   missing until the order expires: `ORDER_TTL_MS`.
 * - The count is the order's length less the slots found empty so far, so it falls as items are
 *   tagged out and checked, and does not rise for joiners until the order is taken again.
 *
 * **Memory.** Eight bytes a slot for the rowid, one for "left the set": an order of the whole
 * production library (13k) is ~120 KB, one of a 200k library ~1.8 MB. At most `ORDER_ENTRIES`
 * orders and `ORDER_SLOTS` slots across all of them, so the worst case is 9 MB of typed arrays
 * plus a key of a kilobyte or two apiece, whatever the library. A set larger than the whole
 * budget is not kept -- recorded as such, so it is not re-sorted only to be refused -- and is
 * paged as before.
 *
 * Emptied by everything in this process that changes membership broadly (`clearLibraryCaches`:
 * trash, restore, purge, hiding, a library added, moved, enabled or disabled). A restart
 * empties it too, which costs one walk per list in use.
 */

/** How long an order is kept. Long enough for a session of stepping; short for a joiner. */
export const ORDER_TTL_MS = 5 * 60_000;
/** Orders kept at once: one per viewer, filter and seed in use in the last few minutes. */
const ORDER_ENTRIES = 32;
/** Slots kept across every order: ~9 MB at nine bytes a slot. */
export const ORDER_SLOTS = 1_000_000;

interface KeptOrder {
    /** The matching items' rowids, in the list's order, as they were when it was taken. */
    rowids: Float64Array;
    /** 1 where a check of that slot found its item no longer in the set. */
    departed: Uint8Array;
    departedCount: number;
    /** `mediaRepo.newestRowid()` when the order was taken. */
    newest: number;
    /** A look's matching moment for each item, by rowid (§5e); absent for every other order. */
    moments?: Map<number, number>;
}

/** `null` records a set too large to keep, so that it is not sorted again to be refused. */
const orders = createTtlCache<KeptOrder | null>(ORDER_TTL_MS, ORDER_ENTRIES, {
    weigh: (order) => order?.rowids.length ?? 0,
    maxWeight: ORDER_SLOTS,
});

/**
 * Whether a query's pages and count are served from a kept order. Expects the override applied.
 *
 * A shuffle always: any page of one sorts the whole set, which is what taking the order costs.
 * An untagged list only when `walking` -- the grid, its count, the viewer stepping through it --
 * because in date order its first page alone is an index walk that stops when the page is full
 * (144 pages for untagged videos on the replica, against 538 to take the whole order), so a
 * one-off read such as a home shelf or a card face is cheaper without it.
 */
export const keepsOrder = (query: MediaQuery, walking: boolean): boolean =>
    query.sort === "random" || query.sort === "look" || (walking && findsUntagged(query.groups));

const take =
    (query: MediaQuery, auth: AuthContext, overlayUserId?: string) => (): KeptOrder | null => {
        const newest = mediaRepo.newestRowid();

        if (query.sort === "look") {
            const { rowids, moments } = takeLookOrder(query, auth, overlayUserId);

            return {
                rowids: Float64Array.from(rowids),
                departed: new Uint8Array(rowids.length),
                departedCount: 0,
                newest,
                moments,
            };
        }

        const rowids = mediaRepo.orderedRowids(
            query,
            auth.userId,
            auth.accessibleRootIds,
            ORDER_SLOTS,
            overlayUserId
        );

        if (rowids.length > ORDER_SLOTS) {
            return null;
        }

        return {
            rowids: Float64Array.from(rowids),
            departed: new Uint8Array(rowids.length),
            departedCount: 0,
            newest,
        };
    };

/**
 * The kept order for a query, taken now if there is none or something has arrived since.
 *
 * Null when the set is too large to keep; the caller pages it the ordinary way. Call inside the
 * caller's snapshot, so the newest-rowid check and the walk see the same database.
 */
export const keptOrder = (
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    now = Date.now()
): KeptOrder | null => {
    const key = orderCacheKey(query, auth, overlayUserId);
    const compute = take(query, auth, overlayUserId);
    const kept = orders.get(key, compute, now);

    if (kept === null || kept.newest === mediaRepo.newestRowid()) {
        return kept;
    }

    orders.delete(key);

    return orders.get(key, compute, now);
};

/**
 * One page of a kept order: its slots' items that are still in the set, in order.
 *
 * Slots are fixed, so `hasMore` is whether any slot lies beyond this page -- a page can be short,
 * or empty, before the last. What each check finds is recorded against the slot, which is what
 * keeps the count honest about items that have left (and returned).
 */
export const pageOfOrder = (
    order: KeptOrder,
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string
): { ids: string[]; hasMore: boolean; moments?: Record<string, number> } => {
    const start = query.page * query.limit;
    const end = Math.min(start + query.limit, order.rowids.length);
    const slice = Array.from(order.rowids.subarray(start, Math.max(start, end)));
    const found = mediaRepo.stillMatching(
        query,
        auth.userId,
        auth.accessibleRootIds,
        slice,
        overlayUserId
    );
    const present = new Set(found.map((row) => row.rowid));

    slice.forEach((rowid, offset) => {
        const slot = start + offset;
        const gone = present.has(rowid) ? 0 : 1;

        order.departedCount += gone - order.departed[slot];
        order.departed[slot] = gone;
    });

    const moments = order.moments;

    return {
        ids: found.map((row) => row.id),
        hasMore: end < order.rowids.length,
        ...(moments && {
            moments: Object.fromEntries(
                found.flatMap((row) => {
                    const atMs = moments.get(row.rowid);

                    return atMs === undefined ? [] : [[row.id, atMs]];
                })
            ),
        }),
    };
};

/** How many items a kept order holds now, and how many pages its slots make. */
export const countOfOrder = (
    order: KeptOrder,
    limit: number
): { total: number; pageCount: number } => ({
    total: order.rowids.length - order.departedCount,
    pageCount: Math.max(1, Math.ceil(order.rowids.length / limit)),
});

/** Forgets every kept order: something changed which items any list can show. */
export const forgetKeptOrders = (): void => orders.clear();
