"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { MediaFrame } from "@private-stock/core";

import { api } from "./client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Capturing frames, and choosing the cover (§13).
 *
 * Every one of these can change which picture represents an item, so every one of them reaches
 * every cache that draws one — `invalidateCovers`.
 */

/**
 * Everything that draws an item's cover.
 *
 * The item and the grid were invalidated and nothing else was, so discarding the capture that
 * was the cover left the room's shelves, the playlist and reel cards and the library cards all
 * naming the old picture. Those URLs are cached as immutable, so they went on showing a still
 * that had just been discarded — and where the browser had not cached one, the alias behind it
 * answered 404 for an item with no generated cover to fall back to, and the tile broke.
 *
 * `media.all()` covers the item, the grid, the counts and the Captures page. The rest are the
 * other shapes a cover is carried in. Only mounted queries refetch; the others are marked stale.
 */
export const invalidateCovers = (queryClient: QueryClient): void => {
    for (const queryKey of [
        queryKeys.media.all(),
        queryKeys.home(),
        queryKeys.playlists.all(),
        queryKeys.reels.all(),
        queryKeys.library.roots(),
        queryKeys.dupes.all(),
    ]) {
        void queryClient.invalidateQueries({ queryKey });
    }
};

const useFrameMutation = <TArgs>(request: (args: TArgs) => Promise<unknown>) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: () => invalidateCovers(queryClient),
    });
};

/**
 * Pull the frame at `atMs` out of the original and keep it.
 *
 * Slower than a click usually is — it is an ffmpeg seek and a decode — so callers show it as
 * pending rather than assuming it is instant.
 */
export const useCaptureFrame = (mediaId: string, onCaptured?: (frame: MediaFrame) => void) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (atMs: number) =>
            api<MediaFrame>(`/api/media/${mediaId}/frames`, {
                method: "POST",
                body: JSON.stringify({ atMs: Math.floor(atMs) }),
            }),
        onSuccess: (frame) => {
            // The first capture of an item can become its cover.
            invalidateCovers(queryClient);
            onCaptured?.(frame);
        },
    });
};

export const useSetCover = (mediaId: string) =>
    useFrameMutation(({ artifactId }: { artifactId: string | null }) =>
        api<{ frames: MediaFrame[] }>(`/api/media/${mediaId}/cover`, {
            method: "PUT",
            body: JSON.stringify({ artifactId }),
        })
    );

export const useDeleteCapture = (mediaId: string) =>
    useFrameMutation(({ artifactId }: { artifactId: string }) =>
        api<{ frames: MediaFrame[] }>(`/api/media/${mediaId}/frames/${artifactId}`, {
            method: "DELETE",
        })
    );
