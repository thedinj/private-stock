"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { LibraryCountResponse, LibraryListResponse } from "@private-stock/core";

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
