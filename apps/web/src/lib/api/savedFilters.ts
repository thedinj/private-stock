"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    CreateSavedFilterInput,
    SavedFilter,
    SavedFilterCovers,
    UpdateSavedFilterInput,
} from "@private-stock/core";

import { api } from "./client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Saved filters, client side (§14b).
 *
 * The whole server half of this — schemas, service, and five route handlers — has existed
 * since phase 0 with nothing calling it. This is the caller.
 *
 * One query key for the list rather than one per filter. The list is small, bounded by how
 * many filters a person is willing to name, and every mutation changes at most one row of it;
 * splitting it up would buy nothing and cost a cache invalidation puzzle.
 */

const KEY = queryKeys.savedFilters();

interface SavedFiltersResponse {
    filters: SavedFilter[];
}

export const useSavedFilters = () =>
    useQuery({
        queryKey: KEY,
        queryFn: () => api<SavedFiltersResponse>("/api/filters"),
        // The same staleness the libraries list uses. Filters change when someone saves one,
        // and that path invalidates explicitly — the interval is only for another tab.
        staleTime: 60_000,
    });

/**
 * A saved view's face, once its card is near the screen (§14c).
 *
 * `enabled` is the card's own visibility, so a page of eighty views asks for the dozen on
 * screen. Minutes of staleness because the server keeps the answer for ten anyway, and a face
 * is a reminder of what a view holds rather than a report of it.
 */
export const useSavedFilterCovers = (filterId: string, enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.savedFilterCovers(filterId),
        queryFn: () => api<SavedFilterCovers>(`/api/filters/${filterId}/covers`),
        enabled,
        staleTime: 5 * 60_000,
    });

/**
 * Everything that writes a filter, sharing one invalidation.
 *
 * `onSuccess` refetches the list rather than patching it in place. A saved filter's response
 * carries fields the client cannot compute — `editable`, `ownerName`, `showsOwnerRatings`,
 * and `viewerRelative`, which is derived from the query on the server precisely so it cannot
 * disagree with it — so reconstructing the row here would be inventing four answers the
 * server already gave. The list is one small request.
 */
const useFilterMutation = <TArgs>(
    request: (args: TArgs) => Promise<unknown>,
    onDone?: (args: TArgs) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: (_result, args) => {
            void queryClient.invalidateQueries({ queryKey: KEY });
            onDone?.(args);
        },
    });
};

export const useCreateSavedFilter = (onCreated?: (filter: SavedFilter) => void) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: CreateSavedFilterInput) =>
            api<SavedFilter>("/api/filters", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: (filter) => {
            void queryClient.invalidateQueries({ queryKey: KEY });
            onCreated?.(filter);
        },
    });
};

/**
 * `onDone` because a rename happens in a dialogue, and a dialogue that closes before the
 * server has agreed hides the one error this endpoint actually produces: a name already
 * taken, which is refused rather than resolved.
 */
export const useUpdateSavedFilter = (onDone?: () => void) =>
    useFilterMutation(
        ({ id, patch }: { id: string; patch: UpdateSavedFilterInput }) =>
            api<SavedFilter>(`/api/filters/${id}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            }),
        () => onDone?.()
    );

/**
 * Where this viewer wants a saved view in their own sidebar (§14b).
 *
 * `null` clears the decision rather than unpinning: it puts the collection back on whatever the
 * household offers, which is a different thing from taking it out.
 *
 * The same shape as `useSetPlaylistPin`, because a view and a playlist are the same object with
 * different mechanics and the two client modules sit beside each other.
 */
export const useSetSavedFilterPin = () =>
    useFilterMutation(({ id, pinned }: { id: string; pinned: boolean | null }) =>
        api<{ filter: SavedFilter }>(`/api/filters/${id}/pin`, {
            method: "PUT",
            body: JSON.stringify({ pinned }),
        })
    );

export const useDeleteSavedFilter = () =>
    useFilterMutation((id: string) => api<void>(`/api/filters/${id}`, { method: "DELETE" }));
