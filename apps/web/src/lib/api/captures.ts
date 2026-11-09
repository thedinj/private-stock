"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { DiscardCapturesResult, MediaFrame } from "@private-stock/core";

import { queryKeys } from "@/lib/api/queryKeys";
import { api } from "./client";
import { invalidateCovers } from "./frames";

/**
 * The Captures page, client side (§9 "Your captures, in one place").
 *
 * Keys live under `media`, so the strokes that change which items can be listed — trash,
 * restore, purge — reach this page without knowing it exists. `docs/CACHE_KEYS.md` §2.
 */

/**
 * Write or clear a capture's caption.
 *
 * The item's detail as well as this page, because the strip's lightbox shows the caption too.
 * Nothing in the grid draws it, so the library pages are left alone.
 */
export const useRenameCapture = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            mediaId,
            artifactId,
            label,
        }: {
            mediaId: string;
            artifactId: string;
            label: string | null;
        }) =>
            api<MediaFrame>(`/api/media/${mediaId}/frames/${artifactId}`, {
                method: "PATCH",
                body: JSON.stringify({ label }),
            }),
        onSuccess: (_frame, { mediaId }) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.libraryAll() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.detail(mediaId) });
        },
    });
};

/**
 * Discard a selection of captures.
 *
 * `invalidateCovers`: a selection spans items, each item's strip changes, and a capture that
 * was an item's cover changes the picture everywhere that item is drawn.
 */
export const useDiscardCaptures = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (artifactIds: string[]) =>
            api<DiscardCapturesResult>("/api/captures/discard", {
                method: "POST",
                body: JSON.stringify({ artifactIds }),
            }),
        onSuccess: () => invalidateCovers(queryClient),
    });
};
