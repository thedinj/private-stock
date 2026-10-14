import { findsUntagged, mediaKinds, type MediaKind, type MediaQuery } from "@private-stock/core";
import { join, mediaRepo, read, type ReadPlan } from "@private-stock/db";

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
 * **One order serves both kind tabs** (§20 "One walk serves both kind tabs"). Opening a filter
 * asks for the grid, its count and the other kind's count at once, and the two kinds' orders were
 * two walks under two keys. A shuffle or an untagged list is now taken without its kind, each
 * slot keeping its item's kind, and a kind's pages and count are the slots of that kind: the same
 * items in the same order as a walk of that kind alone (`mediaIdsPage.test.ts` holds the repo to
 * it), so the Videos tab, the Photos tab and All are three views of one walk. A look is still
 * taken per kind, because it ranks and caps each kind separately (§5e).
 *
 * **One take, however many ask** (§20). Those three requests arrive together, so the order would
 * still have been walked three times -- each finding nothing kept and starting its own take. The
 * first now records its take as in flight, and a request for the same order while it runs waits
 * for it (`join`) instead of walking again.
 *
 * **Memory.** Eight bytes a slot for the rowid, one for its kind, one for "left the set", and
 * four more for a kind's slots once one kind is paged: an order of the whole production library
 * (13k) is ~180 KB, one of a 200k library ~2.8 MB. At most `ORDER_ENTRIES` orders and
 * `ORDER_SLOTS` slots across all of them, so the worst case is 14 MB of typed arrays plus a key of
 * a kilobyte or two apiece, whatever the library. A set larger than the whole budget is not kept
 * -- recorded as such, so it is not re-sorted only to be refused -- and is paged as before.
 *
 * Emptied by everything in this process that changes membership broadly (`clearLibraryCaches`:
 * trash, restore, purge, hiding, a library added, moved, enabled or disabled). A restart
 * empties it too, which costs one walk per list in use.
 */

/** How long an order is kept. Long enough for a session of stepping; short for a joiner. */
export const ORDER_TTL_MS = 5 * 60_000;
/** Orders kept at once: one per viewer, filter and seed in use in the last few minutes. */
const ORDER_ENTRIES = 32;
/** Slots kept across every order: ~14 MB at fourteen bytes a slot. */
export const ORDER_SLOTS = 1_000_000;

interface KeptOrder {
    /** The matching items' rowids, in the list's order, as they were when it was taken. */
    rowids: Float64Array;
    /**
     * Each slot's kind, as its index in `mediaKinds`, for an order taken across both kinds;
     * absent for a look's, which is taken for the kind asked.
     */
    kinds?: Uint8Array;
    /** How many slots of each kind, indexed as `kinds`. */
    kindSlots: number[];
    /** Each kind's slot numbers, in order, made the first time a page of that kind is asked. */
    slotsOfKind: (Uint32Array | undefined)[];
    /** 1 where a check of that slot found its item no longer in the set. */
    departed: Uint8Array;
    departedCount: number;
    /** `departedCount` by kind, indexed as `kinds`. */
    departedOfKind: number[];
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

/**
 * The query whose order is taken and kept for `query`: the same without its kind, unless a look.
 *
 * A kind's order is the slots of that kind in the order of both (`slotsFor`), so leaving the kind
 * out lets one walk serve the Videos tab, the Photos tab and All. A look ranks and caps each kind
 * separately (`takeLookOrder`), so its order for one kind is not a part of its order for both.
 */
const orderedQuery = (query: MediaQuery): MediaQuery =>
    query.sort === "look" ? query : { ...query, kind: undefined };

/** A taken order, with nothing yet found to have left it. */
const keptFrom = (
    rowids: readonly number[],
    newest: number,
    extra: { kinds?: Uint8Array; moments?: Map<number, number> } = {}
): KeptOrder => {
    const kindSlots = mediaKinds.map(() => 0);

    extra.kinds?.forEach((kind) => {
        kindSlots[kind] += 1;
    });

    return {
        rowids: Float64Array.from(rowids),
        kindSlots,
        slotsOfKind: [],
        departed: new Uint8Array(rowids.length),
        departedCount: 0,
        departedOfKind: mediaKinds.map(() => 0),
        newest,
        ...extra,
    };
};

/** Taking an order: the walk on the reader, a look's ranking here (§5e). */
function* take(
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId: string | undefined,
    newest: number
): ReadPlan<KeptOrder | null> {
    if (query.sort === "look") {
        const { rowids, moments } = takeLookOrder(query, auth, overlayUserId);

        return keptFrom(rowids, newest, { moments });
    }

    const { rowids, kinds } = yield* read(
        "orderedRowids",
        query,
        auth.userId,
        auth.accessibleRootIds,
        ORDER_SLOTS,
        overlayUserId
    );

    if (rowids.length > ORDER_SLOTS) {
        return null;
    }

    return keptFrom(rowids, newest, { kinds });
}

/**
 * Bumped by `forgetKeptOrders`, so an order taken across an `await` that a forget overtook is
 * used for the request that took it and not kept. Without it a library disabled mid-walk would
 * be cleared from the cache and then put straight back by the walk that was already running.
 */
let generation = 0;

/**
 * Takes in progress, by key: what a request for the same order waits on rather than walking
 * again (`join`). `newest` is the newest rowid the take began under, so a request that sees an
 * arrival since does not wait for an order that will be stale when it lands. The promise never
 * rejects: a take that fails settles it with `undefined`, and whoever waited takes their own.
 */
const taking = new Map<string, { newest: number; order: Promise<KeptOrder | null | undefined> }>();

/**
 * The kept order for a query, taken now if there is none or something has arrived since.
 *
 * Null when the set is too large to keep; the caller pages it the ordinary way. Run inside the
 * caller's snapshot or plan, so the newest-rowid check and the walk see the same database.
 *
 * A request that finds the same order being taken by another waits for that take (`join`) and is
 * served its result. Under `runNow`, which cannot wait, it takes its own as it always did. Waiting
 * across a forget is harmless: both requests began before it, and the order is served to them and
 * not kept, exactly as for the request that took it.
 */
export function* keptOrder(
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    now = Date.now()
): ReadPlan<KeptOrder | null> {
    const ordered = orderedQuery(query);
    const key = orderCacheKey(ordered, auth, overlayUserId);
    const kept = orders.peek(key, now);

    if (kept === null) {
        return kept;
    }

    const newest = mediaRepo.newestRowid();

    if (kept !== undefined && kept.newest === newest) {
        return kept;
    }

    const inFlight = taking.get(key);

    if (inFlight !== undefined && inFlight.newest === newest) {
        const joined = yield* join(inFlight.order);

        if (joined !== undefined) {
            return joined;
        }
    }

    let settle: (order: KeptOrder | null | undefined) => void = () => undefined;
    const mine = {
        newest,
        order: new Promise<KeptOrder | null | undefined>((resolve) => {
            settle = resolve;
        }),
    };
    const takingGeneration = generation;
    let taken: KeptOrder | null | undefined;

    taking.set(key, mine);

    try {
        taken = yield* take(ordered, auth, overlayUserId, newest);

        if (takingGeneration === generation) {
            orders.set(key, taken, now);
        }

        return taken;
    } finally {
        // Also when the take threw or its plan was abandoned: `taken` is then still undefined,
        // which tells whoever waited to take their own.
        if (taking.get(key) === mine) taking.delete(key);

        settle(taken);
    }
}

/**
 * The slots a query's pages are cut from: a kind's, in order, when the order holds both kinds and
 * the query asks for one; null for all of them.
 */
const slotsFor = (order: KeptOrder, kind: MediaKind | undefined): Uint32Array | null => {
    if (kind === undefined || order.kinds === undefined) {
        return null;
    }

    const code = mediaKinds.indexOf(kind);
    const made = order.slotsOfKind[code];

    if (made !== undefined) {
        return made;
    }

    const kinds = order.kinds;
    const slots = new Uint32Array(order.kindSlots[code]);
    let next = 0;

    for (let slot = 0; slot < kinds.length; slot += 1) {
        if (kinds[slot] === code) slots[next++] = slot;
    }

    order.slotsOfKind[code] = slots;

    return slots;
};

/**
 * One page of a kept order: its slots' items that are still in the set, in order.
 *
 * Slots are fixed, so `hasMore` is whether any slot lies beyond this page -- a page can be short,
 * or empty, before the last. What each check finds is recorded against the slot, which is what
 * keeps the count honest about items that have left (and returned).
 *
 * A query for one kind pages that kind's slots of an order of both (`slotsFor`): its page `n` is
 * the `n`th window of them, so every page of a kind is full but for departures, as a walk of that
 * kind alone would have made it. The slice is checked with the query's own kind, which every slot
 * in it has, so what is recorded holds for the order of both as well.
 */
export function* pageOfOrder(
    order: KeptOrder,
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string
): ReadPlan<{ ids: string[]; hasMore: boolean; moments?: Record<string, number> }> {
    const slots = slotsFor(order, query.kind);
    const length = slots === null ? order.rowids.length : slots.length;
    const start = query.page * query.limit;
    const end = Math.min(start + query.limit, length);
    const positions = Array.from({ length: Math.max(0, end - start) }, (_, offset) =>
        slots === null ? start + offset : slots[start + offset]
    );
    const slice = positions.map((slot) => order.rowids[slot]);
    const found = yield* read(
        "stillMatching",
        query,
        auth.userId,
        auth.accessibleRootIds,
        slice,
        overlayUserId
    );
    const present = new Set(found.map((row) => row.rowid));

    slice.forEach((rowid, offset) => {
        const slot = positions[offset];
        const change = (present.has(rowid) ? 0 : 1) - order.departed[slot];

        order.departed[slot] += change;
        order.departedCount += change;

        if (order.kinds !== undefined) order.departedOfKind[order.kinds[slot]] += change;
    });

    const moments = order.moments;

    return {
        ids: found.map((row) => row.id),
        hasMore: end < length,
        ...(moments && {
            moments: Object.fromEntries(
                found.flatMap((row) => {
                    const atMs = moments.get(row.rowid);

                    return atMs === undefined ? [] : [[row.id, atMs]];
                })
            ),
        }),
    };
}

/**
 * How many items a kept order holds now for a query, and how many pages its slots make: the
 * query's kind's slots in an order of both kinds, else all of them.
 */
export const countOfOrder = (
    order: KeptOrder,
    query: MediaQuery
): { total: number; pageCount: number } => {
    const code = query.kind === undefined ? -1 : mediaKinds.indexOf(query.kind);
    const [slots, departed] =
        code < 0 || order.kinds === undefined
            ? [order.rowids.length, order.departedCount]
            : [order.kindSlots[code], order.departedOfKind[code]];

    return { total: slots - departed, pageCount: Math.max(1, Math.ceil(slots / query.limit)) };
};

/** Forgets every kept order: something changed which items any list can show. */
export const forgetKeptOrders = (): void => {
    generation += 1;
    orders.clear();
    // A take already running finishes for whoever asked and waited, and is not kept; a request
    // after this one must not wait on it, or it would be served the library before the change.
    taking.clear();
};
