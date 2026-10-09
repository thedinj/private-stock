"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";

import type { LibrariesResponse, LibraryStats } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { api } from "@/lib/api/client";
import { invalidateProcessing } from "@/lib/api/processing";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Everything that goes stale when a library changes.
 *
 * Two caches hold the same rows for different readers, and the administration page only ever
 * invalidated its own. `["admin", "scan"]` is the table on that page; `["library", "roots"]`
 * is the list the sidebar, the room and the cellar read — and that one is filtered to enabled
 * roots and ordered by name, so adding, enabling, renaming, moving and forgetting all change
 * it. None of them said so, and the symptom was a library that did not appear in the sidebar
 * until the page was reloaded, which reads as the library not having been added.
 *
 * One function rather than two invalidations at each call site, because the failure mode is
 * remembering one of them: the page you are looking at updates, and the one you are not does
 * not, so nothing looks broken until later.
 */
export const invalidateLibraries = (queryClient: QueryClient): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.scan() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.library.roots() });
    // The root counts an empty grid explains itself with: adding or enabling a library is what
    // turns "no libraries" or "none enabled" into something else.
    void queryClient.invalidateQueries({ queryKey: queryKeys.library.stats() });

    // Adding a library enqueues its first scan, and enabling one makes its contents count
    // towards every stage. Both are work, and the Processing card sleeps through anything it
    // is not told about.
    invalidateProcessing(queryClient);
};

/**
 * The enabled libraries, as every reader of them sees them.
 *
 * Three components had their own copy of this query — the navbar, the room and the cellar —
 * identical down to the `staleTime`, which meant there was nowhere to put a policy about when
 * it should be re-read. `docs/CACHE_KEYS.md` exists to stop exactly that, and this was the
 * cache it had slipped through.
 *
 * **`refetchInterval` is why it matters.** A library added by one administrator was invisible
 * to everybody else already signed in: nothing in the app told their browser, so the Library
 * section of their sidebar listed what existed when they loaded the page. The live-update feed
 * reaches them where a subscriber is mounted (the room and the cellar, via `useLiveUpdates`),
 * but the sidebar is on every page and most pages have no subscriber — so the interval is what
 * makes it true on `/tags`, `/collections`, `/trash` and the rest.
 *
 * A minute rather than something eager. This is a household, and a new library is not something
 * anyone is waiting on to the second; a NAS should not answer the same question from every open
 * tab more often than that (§17).
 *
 * **It is also where the item counts live, including the nav's total** — the expensive numbers,
 * an index entry per item, that `useLibraryStats` used to poll every ten seconds (§20). The
 * server caches them per viewer for the same minute and drops the cache when this process
 * changes a count; the change feed invalidates this query when items arrive or leave
 * (`useLiveUpdates`). So the interval is a backstop, not the way counts stay current.
 */
export const useLibraries = () =>
    useQuery({
        queryKey: queryKeys.library.roots(),
        queryFn: () => api<LibrariesResponse>("/api/library/roots"),
        staleTime: 60_000,
        refetchInterval: 60_000,
        // Not while the tab is hidden (the default, stated because it is a decision): a tab left
        // open overnight would otherwise ask once a minute for numbers nobody is looking at. The
        // interval picks up again when the tab is shown; nothing is lost by sleeping through it.
        refetchIntervalInBackground: false,
    });

/**
 * Whether a scan is running, and the root counts an empty grid explains itself with.
 *
 * The same story as `useLibraries` above, with a worse ending: the app shell and the cellar each
 * had their own copy of this query, identical including a **three second** poll while a scan
 * ran. That number was chosen when the endpoint was four cheap aggregates. Measured on the NAS
 * with the worker mid-backlog it cost 3–13 seconds of synchronous query, so the poll was asking
 * again before the previous answer had come back — a self-inflicted stall on the one process
 * that also serves every page (§20).
 *
 * **Now it is cheap by construction**: the item counts and the queue depth are gone from it (the
 * counts are `useLibraries`, the queue had no reader left), leaving two statements over tables
 * with a handful of rows, answered for every viewer from one short server cache. The interval
 * stays where it was — ten seconds while a scan runs so "Scanning" clears promptly, thirty
 * otherwise so a scan that starts is noticed — because it no longer costs anything worth
 * stretching it to save, and not while the tab is hidden.
 */
export const useLibraryStats = () => {
    const { user } = useAuth();

    return useQuery({
        queryKey: queryKeys.library.stats(),
        queryFn: () => api<LibraryStats>("/api/library/stats"),
        refetchInterval: (query) => (query.state.data?.scanning ? 10_000 : 30_000),
        refetchIntervalInBackground: false,
        /**
         * Not before the session is restored. The app layout reads this outside its auth gate,
         * so on every load it asked before any token existed, took a 401, and started a second
         * refresh of its own — two rotations per page load, and twice the chances to race.
         */
        enabled: user !== null,
    });
};
