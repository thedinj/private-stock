"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    CreatePlaylistInput,
    Playlist,
    PlaylistItemsResponse,
    UpdatePlaylistInput,
} from "@private-stock/core";

import { api } from "./client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Playlists, client side (§14b).
 *
 * The server half — schemas, service, and four route handlers — has existed since phase 0
 * with nothing calling it, the same way saved filters did. This is the caller.
 *
 * Two kinds of key. The list is one query, because it is small and every mutation changes at
 * most one row of it; the items are keyed per playlist, page *and* order, because a page of
 * a shuffle and the same page of the stored order are genuinely different answers and must
 * not be served to each other from the cache.
 */

const LIST_KEY = queryKeys.playlists.all();

/**
 * Built by the factory, not written out.
 *
 * This was a hand-rolled array duplicating `queryKeys.playlists.itemsPage`, and it slipped past
 * `queryKeys.test.ts`, which walks the source for keys written out as array literals — and this
 * was a helper one line above the call rather than the call itself. The two spellings agreed by
 * coincidence rather than by construction, which is the exact failure the registry exists to
 * prevent.
 */
const itemsKey = (playlistId: string, page: number, seed: number | null) =>
    queryKeys.playlists.itemsPage(playlistId, page, seed);

interface PlaylistsResponse {
    playlists: Playlist[];
}

export const usePlaylists = () =>
    useQuery({
        queryKey: LIST_KEY,
        queryFn: () => api<PlaylistsResponse>("/api/playlists"),
        // The same staleness the libraries list and saved filters use. Writes invalidate
        // explicitly; the interval is only for another tab.
        staleTime: 60_000,
    });

export const usePlaylist = (playlistId: string) =>
    useQuery({
        queryKey: queryKeys.playlists.detail(playlistId),
        queryFn: () => api<Playlist>(`/api/playlists/${playlistId}`),
    });

/**
 * One page of a playlist, in whichever order the view is showing.
 *
 * `enabled` waits for the order to be settled. A playlist whose default is shuffle has an
 * undecided address for one render, and fetching the stored order in that gap would put a
 * page on screen that is about to be replaced — a visible flash of the wrong order.
 */
export const usePlaylistItems = (
    playlistId: string,
    page: number,
    seed: number | null,
    enabled = true
) =>
    useQuery({
        queryKey: itemsKey(playlistId, page, seed),
        queryFn: () => {
            const params = new URLSearchParams({ page: String(page) });

            if (seed !== null) params.set("seed", String(seed));

            return api<PlaylistItemsResponse>(
                `/api/playlists/${playlistId}/items?${params.toString()}`
            );
        },
        enabled,
        // Keeps the current page on screen while the next loads, so paging does not flash an
        // empty grid — the same choice the library grid makes.
        placeholderData: (previous) => previous,
    });

/**
 * Everything that writes a playlist, sharing one invalidation.
 *
 * Membership changes invalidate the items of every page and every order, which is why the
 * key is a prefix rather than the exact one that changed. Removing an item shifts every
 * position after it, so a neighbouring page that was already cached is stale by construction
 * — and under a shuffle, "which page was this on" is not a question the client can answer.
 */
const usePlaylistMutation = <TArgs, TResult>(
    request: (args: TArgs) => Promise<TResult>,
    onDone?: (result: TResult, args: TArgs) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: (result, args) => {
            void queryClient.invalidateQueries({ queryKey: LIST_KEY });
            onDone?.(result, args);
        },
    });
};

export const useCreatePlaylist = (onCreated?: (playlist: Playlist) => void) =>
    usePlaylistMutation(
        (input: CreatePlaylistInput) =>
            api<Playlist>("/api/playlists", { method: "POST", body: JSON.stringify(input) }),
        (playlist) => onCreated?.(playlist)
    );

export const useUpdatePlaylist = () =>
    usePlaylistMutation(({ id, patch }: { id: string; patch: UpdatePlaylistInput }) =>
        api<Playlist>(`/api/playlists/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
    );

/**
 * Where this viewer wants a playlist in their own sidebar (§14b).
 *
 * `null` clears the decision rather than unpinning: it puts the collection back on whatever the
 * household offers, which is a different thing from taking it out.
 *
 * Its own endpoint rather than a field on the update, because it is a different act by a
 * different person — editing needs ownership, pinning needs only the right to see the thing.
 */
export const useSetPlaylistPin = () =>
    usePlaylistMutation(({ id, pinned }: { id: string; pinned: boolean | null }) =>
        api<{ playlist: Playlist }>(`/api/playlists/${id}/pin`, {
            method: "PUT",
            body: JSON.stringify({ pinned }),
        })
    );

export const useDeletePlaylist = (onDeleted?: () => void) =>
    usePlaylistMutation(
        (id: string) => api<void>(`/api/playlists/${id}`, { method: "DELETE" }),
        () => onDeleted?.()
    );

export const useAddPlaylistItems = (onAdded?: (result: { added: number }) => void) =>
    usePlaylistMutation(
        ({ id, mediaIds }: { id: string; mediaIds: string[] }) =>
            api<{ added: number; skipped: number }>(`/api/playlists/${id}/items`, {
                method: "POST",
                body: JSON.stringify({ mediaIds }),
            }),
        (result) => onAdded?.(result)
    );

export const useRemovePlaylistItem = () => {
    const queryClient = useQueryClient();

    return usePlaylistMutation(
        ({ id, mediaId }: { id: string; mediaId: string }) =>
            api<void>(`/api/playlists/${id}/items/${mediaId}`, { method: "DELETE" }),
        (_result, { id }) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.playlists.detail(id) });
        }
    );
};

export const useMovePlaylistItem = () => {
    const queryClient = useQueryClient();

    return usePlaylistMutation(
        ({ id, mediaId, toIndex }: { id: string; mediaId: string; toIndex: number }) =>
            api<void>(`/api/playlists/${id}/items`, {
                method: "PATCH",
                body: JSON.stringify({ mediaId, toIndex }),
            }),
        (_result, { id }) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.playlists.detail(id) });
        }
    );
};
