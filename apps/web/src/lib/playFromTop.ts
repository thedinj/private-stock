"use client";

import { useQueryClient } from "@tanstack/react-query";

import type { MediaListResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import {
    effectiveSort,
    PAGE_SIZE,
    viewToParams,
    viewToRequestParams,
    type LibraryView,
} from "@/lib/libraryQuery";
import { useOpenItem } from "@/lib/openItem";
import { rememberReturnTo } from "@/lib/returnTo";

/** The library's page of a set, as the grid asks for it -- so the two share one cache entry. */
export const fetchLibraryPage = (filter: URLSearchParams, page: number) => {
    const params = new URLSearchParams(filter);

    params.set("limit", String(PAGE_SIZE));
    params.set("page", String(page));

    return api<MediaListResponse>(`/api/media?${params.toString()}`);
};

/**
 * Play from the top: the first item of a set, opened in the viewer with the set behind it
 * (`PlayMenu`). Shared by every page that offers it, so "the top" is one answer.
 *
 * Page one of the set whichever page is on screen, under the grid's own key so it is a cache
 * hit when page one is what is showing. The address recorded for the viewer is the set's grid at
 * page one, because that is where the item is -- recording anything else would have the viewer
 * look for it there and find no neighbours. Back still lands on the grid: the viewer corrects
 * the address to wherever playback got to (§14b).
 *
 * The first item, photo or not. The viewer's set is mixed and a photo is a still that advances
 * after its dwell (see `stageDwell`), so skipping ahead to the first video would start somewhere
 * other than the top -- which Showcase and Tasting never do.
 */
export const usePlayFromTop = (): ((view: LibraryView) => Promise<void>) => {
    const queryClient = useQueryClient();
    const openItem = useOpenItem();

    return async (view) => {
        const filter = viewToRequestParams({ ...view, sort: effectiveSort(view) });
        const first = await queryClient.fetchQuery({
            queryKey: queryKeys.media.page(filter.toString(), 0),
            queryFn: () => fetchLibraryPage(filter, 0),
            staleTime: 30_000,
        });
        const target = first.items[0];

        if (!target) return;

        rememberReturnTo(`/?${viewToParams({ ...view, page: 0 }).toString()}`);
        // Warmed before it goes, like any item opened from a tile (§14, "Waiting").
        openItem({
            id: target.id,
            href: `/media/${encodeURIComponent(target.id)}`,
            marker: null,
            picture: target.coverUrl,
        });
    };
};
