"use client";

import { useQuery } from "@tanstack/react-query";

import { parseLookFrame, type MediaListItem, type MediaLookupResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * The item a "more like this" started from, as a tile, and the moment in it (§5e).
 *
 * For the Look section and the chip above the grid, which name the starting point and show its
 * picture. Asked through the same lookup the viewer's up-next strip uses, so an item already
 * fetched there is not fetched again; null until it arrives, or when there is no `like`.
 */
export const useLookSource = (
    like: string
): { item: MediaListItem | null; atMs: number | null } => {
    const frame = like ? parseLookFrame(like) : null;
    const { data } = useQuery({
        queryKey: queryKeys.media.lookup(frame?.mediaId ?? ""),
        queryFn: () => api<MediaLookupResponse>(`/api/media/lookup?ids=${frame?.mediaId}`),
        enabled: frame !== null,
        staleTime: 5 * 60_000,
    });

    return { item: data?.items[0] ?? null, atMs: frame?.atMs ?? null };
};
