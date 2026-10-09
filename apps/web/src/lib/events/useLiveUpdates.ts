"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { HomeResponse, MediaListResponse } from "@private-stock/core";

import { connectLiveUpdates, type LiveEvent } from "./liveUpdates";
import { artifactPatch, patchListPage, patchShelves } from "./patchList";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Applying live updates to what is on screen (§13b).
 *
 * The restraint matters more than the plumbing. **Never reorder the grid under someone's
 * cursor**: if four hundred files land while a user is halfway down the library, moving what
 * is under their pointer is hostile. So the rules are:
 *
 *  - Per-item changes — a cover becoming ready, a rating, a transcode finishing — patch in
 *    place wherever the user is. An in-place patch is never disruptive.
 *  - New items become a count, applied when the user asks for them or returns to the top.
 *  - List-level invalidation is debounced, and skipped while the user is not at the top.
 */

/** Long enough that a burst of changes collapses into one refetch, short enough to feel live. */
const INVALIDATE_DEBOUNCE_MS = 500;

export interface LiveUpdatesState {
    /** Items added since the user last saw the top of the list. */
    pendingCount: number;
    /** Whether the stream is carrying a scan's worth of traffic right now. */
    busy: boolean;
    /** Apply the pending items — refetch the list and clear the count. */
    applyPending: () => void;
}

export interface UseLiveUpdatesOptions {
    /**
     * Whether new items may be inserted without asking.
     *
     * True when the user is at the top of an unfiltered, newest-first list — the one case
     * where an arriving item belongs exactly where it would appear anyway.
     */
    autoApply: boolean;
    /** Suppressed while a modal or the player is open: nothing should move behind them. */
    enabled?: boolean;
    /**
     * Called, debounced, when items may have changed or left while new ones are not applied.
     *
     * For a list that keeps its order (the library grid, §14b): a probe finishing, a tag, a
     * trash elsewhere. The list re-asks about what it is showing rather than refetching, so
     * tiles update and removed ones drop out without anything new arriving among them.
     */
    onItemsChanged?: () => void;
}

export const useLiveUpdates = ({
    autoApply,
    enabled = true,
    onItemsChanged,
}: UseLiveUpdatesOptions): LiveUpdatesState => {
    const queryClient = useQueryClient();
    const [pendingCount, setPendingCount] = useState(0);
    const [busy, setBusy] = useState(false);

    const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Read inside the event handler, which is registered once — a ref keeps the connection
    // from being torn down and rebuilt every time the user scrolls to or from the top.
    const autoApplyRef = useRef(autoApply);
    autoApplyRef.current = autoApply;
    const onItemsChangedRef = useRef(onItemsChanged);
    onItemsChangedRef.current = onItemsChanged;
    const itemsChangedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** Debounced like the list refetch, so a scan's worth of probes costs one lookup. */
    const itemsChanged = useCallback(() => {
        if (itemsChangedTimer.current) {
            clearTimeout(itemsChangedTimer.current);
        }

        itemsChangedTimer.current = setTimeout(
            () => onItemsChangedRef.current?.(),
            INVALIDATE_DEBOUNCE_MS
        );
    }, []);

    /**
     * Items arrived or left, so the counts are stale (§20).
     *
     * `library.roots()` is where every item count lives — each library's, and the nav's total —
     * and it is the expensive question, an index entry per item. So it is asked again only for
     * the events that can change a count: an insert, a removal, a summary that includes either,
     * a resync. **Not for updates**, which are now the common event — every probe records one —
     * and never change how many items there are; refetching the counts on each was the poll
     * that froze the web process, driven by the feed instead of a timer. The server caches the
     * answer per viewer too, so a scan's worth of inserts costs at most one count a minute.
     *
     * `library.stats()` rides along because it is cheap and an insert is the first sign a scan
     * has started — the "Scanning" badge need not wait for its poll.
     */
    const countsChanged = useCallback(() => {
        if (countsTimer.current) {
            clearTimeout(countsTimer.current);
        }

        countsTimer.current = setTimeout(() => {
            /**
             * The sidebar's list of libraries, which carries a count per library and can gain a
             * whole row. A library added by one administrator was invisible to everybody else
             * already signed in until they reloaded; its first scan produces exactly these
             * events, so this is where the rest of the household hears about it — and
             * `useLibraries` keeps a slow interval for the pages that have no subscriber mounted.
             */
            void queryClient.invalidateQueries({ queryKey: queryKeys.library.roots() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.library.stats() });
        }, INVALIDATE_DEBOUNCE_MS);
    }, [queryClient]);

    const invalidateList = useCallback(() => {
        if (invalidateTimer.current) {
            clearTimeout(invalidateTimer.current);
        }

        invalidateTimer.current = setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
            /**
             * The shelves and the playlists are views of the same library.
             *
             * Named here rather than left to each page, because a page that shows library
             * content and does not hear about it changing is the bug this exists to prevent
             * — and the failure is silent, since stale content looks exactly like correct
             * content. A key with nothing cached under it is a no-op, so listing one costs
             * nothing on the pages that do not use it.
             */
            void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.playlists.all() });
            setPendingCount(0);
        }, INVALIDATE_DEBOUNCE_MS);
    }, [queryClient]);

    const applyPending = useCallback(() => {
        setPendingCount(0);
        void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.playlists.all() });
    }, [queryClient]);

    /**
     * Patch a changed artifact into every list that is already showing the item.
     *
     * `artifactPatch` decides what the event means for a tile; anything else (a sprite sheet)
     * changes nothing a list draws, so the lists are left alone and only the item's own page is
     * refreshed. The next full refetch restores the long-lived URL.
     */
    const patchArtifact = useCallback(
        (mediaId: string, kind: string | null, version: number) => {
            const patch = artifactPatch(mediaId, kind, version);

            if (patch) {
                /**
                 * The grid, one cache entry per page of per filter (§13b). Scoped to
                 * `media.list()` rather than `media.all()`, which also matches an item's own
                 * details and would hand this updater a single item where it expects a page.
                 */
                queryClient.setQueriesData<MediaListResponse>(
                    { queryKey: queryKeys.media.list() },
                    (page) => patchListPage(page, mediaId, patch)
                );

                // The room, where a newly added item is most likely to be sitting when its
                // cover is made, and whose shelves hold the same items in a different shape.
                queryClient.setQueriesData<HomeResponse>({ queryKey: queryKeys.home() }, (home) =>
                    patchShelves(home, mediaId, patch)
                );
            }

            void queryClient.invalidateQueries({
                queryKey: queryKeys.media.detail(mediaId),
                exact: false,
            });
        },
        [queryClient]
    );

    const markBusy = useCallback(() => {
        setBusy(true);

        if (busyTimer.current) {
            clearTimeout(busyTimer.current);
        }

        // Nothing announces the end of a burst, so it is inferred from the silence after it.
        busyTimer.current = setTimeout(() => setBusy(false), 4_000);
    }, []);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const onEvent = (event: LiveEvent): void => {
            if (event.type === "resync") {
                markBusy();
                // Too much happened to say what; that much is a scan, and counts moved.
                countsChanged();

                // A list that keeps its order re-checks what it shows rather than refetching.
                if (!autoApplyRef.current && onItemsChangedRef.current) {
                    itemsChanged();
                } else {
                    invalidateList();
                }

                return;
            }

            if (event.type === "summary") {
                markBusy();

                if (event.summary.added > 0 && !autoApplyRef.current) {
                    setPendingCount((count) => count + event.summary.added);
                }

                // The counts are stale regardless of whether the grid should move — but only if
                // something arrived or left. A summary of nothing but probes changes no count.
                if (event.summary.added > 0 || event.summary.removed > 0) {
                    countsChanged();
                }

                if (autoApplyRef.current) {
                    invalidateList();
                } else {
                    if (event.summary.updated > 0 || event.summary.removed > 0) {
                        itemsChanged();
                    }
                }

                return;
            }

            const { change } = event;

            if (change.entity === "artifact" && change.entityId) {
                // Always applied, wherever the user is: a thumbnail appearing is the single
                // most visible sign the app is working, and it moves nothing.
                patchArtifact(change.entityId, change.detail, change.id);
                return;
            }

            if (change.entity !== "media") {
                return;
            }

            if (change.op !== "update") {
                countsChanged();
            }

            if (change.op === "insert") {
                if (autoApplyRef.current) {
                    invalidateList();
                } else {
                    setPendingCount((count) => count + 1);
                }

                return;
            }

            /**
             * An update or a removal, which is now the common event rather than a rare one:
             * every probe records one, because finishing a probe is what turns "processing…"
             * into a title, a duration and a size.
             *
             * **Refetched only from the top.** A refetch is the whole page again, and while a
             * scan is inserting items at the top of a newest-first library, the whole page
             * again is a different set of items — so for somebody standing on page five it is
             * precisely the reorder-under-the-cursor this module exists to prevent, and it
             * would also clear the "N new items" count they have not applied yet. They keep
             * the count, and get everything current the moment they apply it.
             *
             * Debounced, so a scan's worth of probes costs one refetch rather than hundreds.
             */
            if (autoApplyRef.current) {
                invalidateList();
                return;
            }

            // Safe wherever the viewer is: it moves no tile.
            itemsChanged();

            if (change.entityId) {
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.media.detail(change.entityId),
                });
            }
        };

        const disconnect = connectLiveUpdates(onEvent);

        return () => {
            disconnect();

            if (invalidateTimer.current) {
                clearTimeout(invalidateTimer.current);
            }
            if (busyTimer.current) {
                clearTimeout(busyTimer.current);
            }
            if (itemsChangedTimer.current) {
                clearTimeout(itemsChangedTimer.current);
            }
            if (countsTimer.current) {
                clearTimeout(countsTimer.current);
            }
        };
    }, [
        enabled,
        countsChanged,
        invalidateList,
        itemsChanged,
        markBusy,
        patchArtifact,
        queryClient,
    ]);

    return { pendingCount, busy, applyPending };
};
