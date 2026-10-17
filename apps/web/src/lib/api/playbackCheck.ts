import { useQuery } from "@tanstack/react-query";

import type { PlaybackCheck } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/** The playback check's test set (§8). Read once per visit: the page is a test run, not a view. */
export const usePlaybackCheck = () =>
    useQuery({
        queryKey: queryKeys.admin.playbackCheck(),
        queryFn: () => api<PlaybackCheck>("/api/admin/playback-check"),
        staleTime: Infinity,
    });
