"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { ItemReviews, MediaDetail, ReviewPass, ReviewPassList } from "@private-stock/core";

import { api } from "./client";
import { queryKeys } from "./queryKeys";

/**
 * Review passes and their marks, client side (§14d "Reviewing recordings for a reel").
 *
 * A handful per person, so each list is one small query. What goes stale when is written once
 * here and in `docs/CACHE_KEYS.md` §2: a mark is a membership test like a rating -- "Not yet
 * reviewed for Wins" stops holding the item -- and moves its pass's count.
 */

/** Your passes in this room: the viewer's Review menu, the selection bar, the filter panel. */
export const useReviewPasses = () =>
    useQuery({
        queryKey: queryKeys.reviewPasses.here(),
        queryFn: () => api<ReviewPassList>("/api/review-passes"),
        staleTime: 60_000,
    });

/** Your passes in every room, for the Account page's card. */
export const useAllReviewPasses = (enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.reviewPasses.everywhere(),
        queryFn: () => api<ReviewPassList>("/api/review-passes?rooms=all"),
        enabled,
        staleTime: 60_000,
    });

/**
 * What a mark, or a pass going, makes stale: the lists filtered by passes and their counts,
 * the room's shelves (a saved view on one), and the passes' own counts. `invalidateQueries`
 * refetches only what is mounted, so a run of `d` presses spends one refetch on the way back.
 */
export const invalidateReviews = (queryClient: QueryClient): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviewPasses.all() });
};

export const useCreateReviewPass = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (name: string) =>
            api<ReviewPass>("/api/review-passes", {
                method: "POST",
                body: JSON.stringify({ name }),
            }),
        onSuccess: (pass) => {
            // Into the room's list at once: review mode goes straight to the new pass, and the
            // viewer resolves the address against this list -- an old one would send it back to
            // the last pass used before the refetch landed.
            queryClient.setQueryData<ReviewPassList>(queryKeys.reviewPasses.here(), (current) =>
                current ? { passes: [...current.passes, pass] } : current
            );
            void queryClient.invalidateQueries({ queryKey: queryKeys.reviewPasses.all() });
        },
    });
};

export const useRenameReviewPass = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ passId, name }: { passId: string; name: string }) =>
            api<ReviewPass>(`/api/review-passes/${encodeURIComponent(passId)}`, {
                method: "PATCH",
                body: JSON.stringify({ name }),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.reviewPasses.all() });
            // The item page's chips say the pass's name, read with the item.
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
        },
    });
};

export const useDeleteReviewPass = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (passId: string) =>
            api<{ marks: number }>(`/api/review-passes/${encodeURIComponent(passId)}`, {
                method: "DELETE",
            }),
        onSuccess: () => invalidateReviews(queryClient),
    });
};

/**
 * One item marked for a pass, or the mark taken off.
 *
 * The id travels with the call rather than being bound to the page, because `d` marks an item
 * and leaves it in one keystroke: a save that lands after the page has moved on still patches
 * the item it was about. The answer -- the item's passes -- is written into its detail first,
 * so the chips do not flicker back while the refetch is on its way.
 */
export const useSetReviewMark = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            mediaId,
            passId,
            reviewed,
        }: {
            mediaId: string;
            passId: string;
            reviewed: boolean;
        }) =>
            api<ItemReviews>(`/api/media/${encodeURIComponent(mediaId)}/reviews`, {
                method: "PUT",
                body: JSON.stringify({ passId, reviewed }),
            }),
        onSuccess: (result, { mediaId }) => {
            queryClient.setQueryData<MediaDetail>(queryKeys.media.detail(mediaId), (current) =>
                current ? { ...current, reviews: result.reviews } : current
            );
            invalidateReviews(queryClient);
        },
    });
};
