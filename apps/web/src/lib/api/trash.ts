"use client";

import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Everything that lists an item, for the strokes that change whether it can be listed at all:
 * moving it to the trash, restoring it, purging it (§10).
 *
 * Only `media.all()` and the bin were invalidated, so an item deleted from its own page went on
 * sitting in "Recently added" when the page sent the viewer home — the room's shelves are
 * filtered lists by another name, and a trashed item has left every one of them. Playlists and
 * the library cards carry the same items and per-library counts — and `library.roots()` is also
 * where the nav's total comes from. Only mounted queries refetch; the others are marked stale.
 */
export const invalidateListable = (queryClient: QueryClient): void => {
    for (const queryKey of [
        queryKeys.media.all(),
        queryKeys.home(),
        queryKeys.playlists.all(),
        queryKeys.library.roots(),
        queryKeys.trash(),
        // An unreadable file moves between its two lists, or off both, on each of these.
        queryKeys.admin.unreadable(),
        // A tag page's "appears with" counts and strips: held for minutes rather than the
        // default half-minute (`useTagCompanions`), so nothing else would refresh them.
        queryKeys.tags.companionsAll(),
    ]) {
        void queryClient.invalidateQueries({ queryKey });
    }
};
