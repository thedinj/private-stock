import type { MediaQuery } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * What a cached answer to `query` is keyed by: who asked, what they can reach, whose ratings
 * it reads, and the query itself without its position.
 *
 * The seed and the page are left out because a cache of this kind holds the matching set, or a
 * draw from it, rather than one page of one shuffle. The viewer and their libraries are in
 * because the same query names different items for different people (§6, §14b).
 */
export const queryCacheKey = (
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string
): string =>
    JSON.stringify([
        auth.userId,
        auth.accessibleRootIds,
        overlayUserId ?? null,
        { ...query, seed: null, page: null },
    ]);

/**
 * What a kept order (`keptOrders.ts`) is keyed by: everything `queryCacheKey` keys by, and the
 * shuffle's seed, because there the order *is* the thing kept.
 *
 * The page and the limit are still left out, so the grid's pages of sixty and the showcase's
 * of two hundred are served from one order. A seed only a shuffle reads is left out of any
 * other sort, so it cannot split one order into several. Seedless shuffles run on seed 1
 * (`rowidShuffleParams`), and are keyed so.
 */
export const orderCacheKey = (
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string
): string =>
    JSON.stringify([
        auth.userId,
        auth.accessibleRootIds,
        overlayUserId ?? null,
        {
            ...query,
            seed: query.sort === "random" ? (query.seed ?? 1) : null,
            page: null,
            limit: null,
        },
    ]);
