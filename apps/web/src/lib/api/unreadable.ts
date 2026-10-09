import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import type {
    BulkActionResult,
    EmptyTrashResponse,
    UnreadablePage,
    UnreadableTab,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { invalidateProcessing } from "@/lib/api/processing";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateListable } from "@/lib/api/trash";

/**
 * Files the probe cannot read (§10g): reviewing them, and giving their space back.
 *
 * The list loads a page at a time from a cursor, like the other review pages. It is short in a
 * healthy library, but a bad import -- a folder of interrupted downloads -- can make it long in
 * an afternoon, and it is the rows nobody has scrolled to that a "select all" must not reach.
 */

/** While anything on the trash tab is still being copied in, look again this often. */
const MOVING_POLL_MS = 3000;

export const useUnreadable = (tab: UnreadableTab) =>
    useInfiniteQuery({
        queryKey: queryKeys.admin.unreadablePage(tab),
        queryFn: ({ pageParam }) =>
            api<UnreadablePage>(
                `/api/admin/unreadable?tab=${tab}${pageParam ? `&after=${encodeURIComponent(pageParam)}` : ""}`
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
        // Only a move in progress changes this list by itself, and only on the trash side.
        refetchInterval: (query) =>
            query.state.data?.pages.some((page) => page.items.some((item) => item.moving))
                ? MOVING_POLL_MS
                : false,
    });

/**
 * Moves the chosen files to the trash, through the same bulk action the library uses.
 *
 * So the permission, the writable-library check, the free-space check on `/data` and the
 * per-item reasons for anything refused are the ones every other deletion gets.
 */
export const useTrashUnreadable = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (mediaIds: string[]) =>
            api<BulkActionResult>("/api/media/bulk", {
                method: "POST",
                body: JSON.stringify({ action: "trash", mediaIds }),
            }),
        onSuccess: () => {
            invalidateListable(queryClient);
            // A trashed item leaves the processing totals as well.
            invalidateProcessing(queryClient);
        },
    });
};

/** Purges the chosen files from the trash now, rather than when the bin's window closes. */
export const usePurgeUnreadable = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (mediaIds: string[]) =>
            api<EmptyTrashResponse>("/api/admin/unreadable/purge", {
                method: "POST",
                body: JSON.stringify({ mediaIds }),
            }),
        onSuccess: () => invalidateListable(queryClient),
    });
};

/**
 * Asks for one file to be read again, for a failure that may not have been the file's fault.
 *
 * The answer comes later, from the worker, so the list is only marked stale here: a file the
 * probe reads this time leaves it the next time it loads.
 */
export const useRereadUnreadable = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (mediaId: string) =>
            api<{ queued: boolean }>(`/api/media/${mediaId}/process`, {
                method: "POST",
                body: JSON.stringify({ stage: "probe" }),
            }),
        onSettled: () => {
            invalidateProcessing(queryClient);

            return queryClient.invalidateQueries({ queryKey: queryKeys.admin.unreadable() });
        },
    });
};
