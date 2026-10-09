import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    FailedJobPage,
    RetryFailedJobs,
    RetryFailedJobsResult,
    TranscodeQueue,
    TranscodeRequeueResult,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { invalidateProcessing } from "@/lib/api/processing";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Failed work and the transcode queue (§13c, §8), for the Processing page.
 *
 * Both caches sit under `admin.processing()`, so a retry -- which is work -- refreshes the
 * progress card, the failure list and the queue in the one stroke `invalidateProcessing` is.
 */

/** Standing failures, newest first; `kind` is "" for every kind. */
export const useFailedJobs = (kind: string) =>
    useInfiniteQuery({
        queryKey: queryKeys.admin.failedJobs(kind),
        queryFn: ({ pageParam }) => {
            const params = new URLSearchParams();
            if (kind) params.set("kind", kind);
            if (pageParam) params.set("after", pageParam);

            return api<FailedJobPage>(`/api/admin/jobs/failed?${params.toString()}`);
        },
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
    });

export const useRetryFailedJobs = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: RetryFailedJobs) =>
            api<RetryFailedJobsResult>("/api/admin/jobs/retry", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: () => invalidateProcessing(queryClient),
    });
};

export const useTranscodeQueue = () =>
    useQuery({
        queryKey: queryKeys.admin.transcodeQueue(),
        queryFn: () => api<TranscodeQueue>("/api/admin/transcode"),
        // Only while something is moving, like the progress card.
        refetchInterval: (query) =>
            (query.state.data?.pending ?? 0) + (query.state.data?.running ?? 0) > 0 ? 5_000 : false,
    });

/** Queue a web-safe copy of everything a browser cannot play and that has none yet. */
export const useRequeueTranscodes = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => api<TranscodeRequeueResult>("/api/admin/transcode", { method: "POST" }),
        onSuccess: () => invalidateProcessing(queryClient),
    });
};
