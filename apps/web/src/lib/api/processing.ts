import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { AdminSettings, MediaDetail } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Waking the Processing card (§7b).
 *
 * The card polls itself while work is moving and **stops when it is not** — see
 * `activeInterval` in `ProcessingProgress`, which returns `false` on an idle library so a NAS
 * is not asked what it is doing every two seconds all night.
 *
 * That left one gap, and everything which causes work fell into it: nothing invalidated this
 * cache, anywhere. Asking for a scan enqueued the job, refreshed the admin table, and left the
 * card asleep on data from whenever it last stopped polling — so it said "up to date" while a
 * scan ran, and reloading was the only way to find out otherwise.
 *
 * `invalidateQueries` fixes both halves at once: the refetch brings the card up to date, and
 * `refetchInterval` is then re-evaluated against the new data, so polling restarts by itself
 * because the data now says something is happening.
 *
 * One function rather than an invalidation at each call site, because the call sites are
 * everything that can cause work — a scan, a settings change that makes a stage applicable, a
 * stage asked for by hand, a library added — and they are spread across the app. A new one that
 * forgets produces a card that is silently wrong rather than visibly broken.
 */
export const invalidateProcessing = (queryClient: QueryClient): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.processing() });
};

/** Short, because somebody is watching for this one; bounded, because it only runs while they are. */
const STAGE_WORK_POLL_MS = 3000;

/**
 * How often an item's detail should look again, given what it last said (§7b).
 *
 * Only while one of its stages is queued or running, and not at all otherwise. Asking for a
 * stage used to change nothing on the page until a reload: the POST returned in milliseconds,
 * the work took minutes, and nothing was watching for the end of it. The answer then arrives
 * on its own -- the row settles, the run control comes back, and read text appears in its
 * section -- and an item with nothing on the way costs no requests at all.
 *
 * Passed as a function so TanStack re-evaluates it against every fetch, which is what stops
 * the polling once the last of the work lands.
 */
export const stageWorkInterval = (query: {
    state: { data: MediaDetail | undefined };
}): number | false =>
    query.state.data?.provenance.some((entry) => entry.inFlight !== null)
        ? STAGE_WORK_POLL_MS
        : false;

/**
 * Asking for one stage to run on one item, now (§7b).
 *
 * The on-demand half of the pipeline, which has had a route since it was written and no way
 * to reach it. It matters more as the registry grows: a capability can be runnable per item
 * long before — or without ever — being swept across a whole library, and that is what makes
 * an expensive one practical to offer at all.
 *
 * Requested work is exempt from the working window (§7c), so this runs when it is asked for
 * rather than waiting for the overnight slot.
 */
export const useRunStage = (mediaId: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (stage: string) =>
            api<{ queued: boolean }>(`/api/media/${mediaId}/process`, {
                method: "POST",
                body: JSON.stringify({ stage }),
            }),
        // The ledger is part of the item's detail, and the row this just queued should read
        // as queued rather than as whatever it said before.
        onSettled: () => {
            // This is work too, and it is the least visible kind: one item, asked for by hand,
            // with no scan to make the card wake up on its own.
            invalidateProcessing(queryClient);

            return queryClient.invalidateQueries({ queryKey: queryKeys.media.detail(mediaId) });
        },
    });
};

interface AdminSettingsResponse {
    settings: AdminSettings;
}

/**
 * The kill switch (§7c "Pausing"): whether background processing is paused, and since when.
 *
 * Read from the admin settings, the same cache the settings cards use, so pausing from the OCR
 * page and from the admin page cannot show two different answers.
 */
export const useProcessingPause = (enabled = true) =>
    useQuery({
        queryKey: queryKeys.admin.settings(),
        queryFn: () => api<AdminSettingsResponse>("/api/admin/settings"),
        select: (data) => data.settings.pause,
        enabled,
    });

export const useSetProcessingPause = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (paused: boolean) =>
            api<AdminSettingsResponse>("/api/admin/settings", {
                method: "PUT",
                body: JSON.stringify({ pause: { paused, since: null } }),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.admin.settings() });
            // Pausing returns running work to the queue and resuming lets it go: either way
            // the Processing card has something new to say (§7b).
            invalidateProcessing(queryClient);
        },
    });
};
