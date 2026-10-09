import type { QueryClient } from "@tanstack/react-query";

import type { MediaListResponse, PlaylistItemsResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

import { type ShowcaseSet, showcasePageKey } from "./set";

/** One page of a showcase set, whichever kind it is. */
export type ShowcasePage = Pick<MediaListResponse, "items" | "hasMore" | "moments">;

/**
 * One page of the set, through the cache the viewer will look in (§14f, §14g).
 *
 * A library page is the showcase's two hundred under the showcase's key. A playlist page is
 * the playlist's own, stored exactly as the playlist page stores it -- that cache is shared, so
 * what goes into it has to be what the playlist page expects to find.
 *
 * `staleTime: Infinity` because the first answer for a page is the one a mode keeps: a page
 * refetched under the show would move every index after the change.
 */
export const fetchShowcasePage = (
    queryClient: QueryClient,
    set: ShowcaseSet,
    page: number
): Promise<ShowcasePage> => {
    if (set.kind === "playlist") {
        const params = new URLSearchParams({ page: String(page) });

        if (set.seed !== null) params.set("seed", String(set.seed));

        return queryClient.fetchQuery({
            queryKey: queryKeys.playlists.itemsPage(set.playlistId, page, set.seed),
            queryFn: () =>
                api<PlaylistItemsResponse>(
                    `/api/playlists/${set.playlistId}/items?${params.toString()}`
                ),
            staleTime: Infinity,
        });
    }

    const key = showcasePageKey(set.filter);
    const params = new URLSearchParams(key);

    params.set("page", String(page));

    return queryClient.fetchQuery({
        queryKey: queryKeys.media.page(key, page),
        queryFn: () => api<MediaListResponse>(`/api/media?${params.toString()}`),
        staleTime: Infinity,
        gcTime: 60_000,
    });
};
