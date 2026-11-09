"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
    REEL_ITEM_LIMIT,
    type LibraryClipRun,
    type LibraryCountResponse,
    type LibraryListResponse,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import {
    PAGE_SIZE,
    effectiveSort,
    libraryRequestParams,
    type LibraryView,
} from "@/lib/libraryQuery";

/**
 * The library's Clips, Stills and All tabs, client side (§14e "What a kind is").
 *
 * The page and the count are two requests, as the grid's are (§20): the count is the dearer
 * question and does not change with the page.
 */

const paramsOf = (view: LibraryView): string =>
    libraryRequestParams({ ...view, sort: effectiveSort(view) }).toString();

export const useLibraryPage = (view: LibraryView, enabled: boolean) => {
    const params = paramsOf(view);

    return useQuery({
        queryKey: queryKeys.media.libraryPage(params, view.page),
        queryFn: () =>
            api<LibraryListResponse>(`/api/library?${params}&limit=${PAGE_SIZE}&page=${view.page}`),
        enabled,
        // The previous page stays on screen while the next loads, as the grid's does.
        placeholderData: keepPreviousData,
    });
};

export const useLibraryCount = (view: LibraryView, enabled = true) => {
    const params = paramsOf(view);

    return useQuery({
        queryKey: queryKeys.media.libraryCount(params),
        queryFn: () => api<LibraryCountResponse>(`/api/library/count?${params}&limit=${PAGE_SIZE}`),
        enabled,
        staleTime: 60_000,
        placeholderData: keepPreviousData,
    });
};

/**
 * Played from the top (§14e "Playing the small kinds"): the tab's first reel's worth in one
 * answer, so a show never stops to ask for the next page. Fetched when Play is pressed.
 */
/** The Clips tab's run as one query, so the clip page and Play from the top share its cache. */
export const clipRunQuery = (view: LibraryView) => {
    const params = paramsOf({ ...view, kind: "clip" });

    return {
        queryKey: queryKeys.media.libraryClipRun(params),
        queryFn: () => api<LibraryClipRun>(`/api/library/play?${params}`),
    };
};

export const useLibraryClipRun = (view: LibraryView, enabled: boolean) =>
    useQuery({ ...clipRunQuery(view), enabled });

export const useLibraryStillRun = (view: LibraryView, enabled: boolean) => {
    const params = paramsOf(view);

    return useQuery({
        queryKey: queryKeys.media.libraryStillRun(params),
        queryFn: () =>
            api<LibraryListResponse>(`/api/library?${params}&limit=${REEL_ITEM_LIMIT}&page=0`),
        enabled,
    });
};
