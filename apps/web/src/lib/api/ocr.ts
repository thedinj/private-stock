import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
    type InfiniteData,
    type QueryClient,
    type QueryKey,
} from "@tanstack/react-query";

import type {
    OcrBench,
    OcrExpectedInput,
    TuneEstimates,
    TuneStartInput,
    TuneView,
    OcrChangeResult,
    OcrCounts,
    OcrEditInput,
    OcrMatchDecideInput,
    OcrMatchItemPage,
    OcrMatchManualInput,
    OcrMatchPage,
    OcrMatchResult,
    OcrMatchStatus,
    OcrQueueAcceptInput,
    OcrQueuePage,
    OcrQueueSkipInput,
    OcrReviewInput,
    OcrRuleTagPage,
    OcrRuleTagUndoInput,
    OcrSettings,
    OcrSettingsView,
    ReviewMedia,
} from "@private-stock/core";
import { reviewMediaKind } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateVocabulary } from "@/lib/api/tags";

/**
 * OCR: the queue of items whose text names a performer or source, the log of what rules tagged,
 * the Rules list, and correcting text from an item's details (§5d).
 *
 * Every list here loads a page at a time from a cursor and keeps going as the reader scrolls.
 * Nothing refetches every loaded page after an action: the rows acted on are patched where they
 * sit, and the rest of the OCR caches are only marked stale for when they are next shown.
 */

const query = (params: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value) search.set(key, value);
    }

    return search.toString();
};

const withCursor = (params: string, after: string | null): string =>
    after ? `${params}${params ? "&" : ""}after=${encodeURIComponent(after)}` : params;

export const useOcrCounts = () =>
    useQuery({
        queryKey: queryKeys.ocr.counts(),
        queryFn: () => api<OcrCounts>("/api/ocr/counts"),
    });

/**
 * Change the rows of a loaded infinite list in place.
 *
 * `edit` returns the row as it should now read, or null to take it off the list. The cursors
 * stay valid: they point at sort values, not positions, so a page that lost rows still
 * continues from where it did.
 */
export const patchInfinite = <Page, Row>(
    queryClient: QueryClient,
    key: QueryKey,
    rowsOf: (page: Page) => Row[],
    withRows: (page: Page, rows: Row[]) => Page,
    edit: (row: Row) => Row | null
): void => {
    queryClient.setQueryData<InfiniteData<Page>>(key, (data) =>
        data
            ? {
                  ...data,
                  pages: data.pages.map((page) =>
                      withRows(
                          page,
                          rowsOf(page).flatMap((row) => {
                              const next = edit(row);
                              return next === null ? [] : [next];
                          })
                      )
                  ),
              }
            : data
    );
};

/**
 * After any OCR action (§5d).
 *
 * The counts refetch, because they are cheap and on screen. The other OCR lists are marked
 * stale without being refetched — `refetchType: "none"` — so a list somebody switches to loads
 * fresh, while the one they are working through is left as the caller patched it rather than
 * reloaded page by page. Each item whose text or tags changed has its details refreshed, so a
 * player open on it shows the change.
 */
const afterChange = (queryClient: QueryClient, mediaIds: string[]): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.all(), refetchType: "none" });
    void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.counts() });

    for (const mediaId of mediaIds) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.media.detail(mediaId) });
    }
};

export const useOcrReview = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: OcrReviewInput) =>
            api<OcrChangeResult>("/api/ocr/review", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: (result) => afterChange(queryClient, result.mediaIds),
    });
};

export const useOcrEdit = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: OcrEditInput) =>
            api<OcrChangeResult>("/api/ocr/edit", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: (result) => afterChange(queryClient, result.mediaIds),
    });
};

/**
 * Items whose text names somebody nobody has decided about, newest first (§5d), of videos,
 * photos or both.
 */
export const useOcrQueue = (media: ReviewMedia) =>
    useInfiniteQuery({
        queryKey: queryKeys.ocr.queueOf(media),
        queryFn: ({ pageParam }) =>
            api<OcrQueuePage>(
                `/api/ocr/queue?${withCursor(query({ media: reviewMediaKind(media) }), pageParam)}`
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
    });

/** What rules tagged by themselves, newest first: the log they are checked against (§5d). */
export const useOcrRuleTags = () =>
    useInfiniteQuery({
        queryKey: queryKeys.ocr.ruleTags(),
        queryFn: ({ pageParam }) =>
            api<OcrRuleTagPage>(`/api/ocr/rules/tags?${withCursor("", pageParam)}`),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
    });

export interface OcrMatchFilters {
    status: OcrMatchStatus;
    search: string;
}

export const ocrMatchesKey = (filters: OcrMatchFilters): QueryKey =>
    queryKeys.ocr.matches(query({ ...filters }));

/** Strings with a decided pair: the Rules list (§5d). */
export const useOcrMatches = (filters: OcrMatchFilters) => {
    const params = query({ ...filters });

    return useInfiniteQuery({
        queryKey: queryKeys.ocr.matches(params),
        queryFn: ({ pageParam }) =>
            api<OcrMatchPage>(`/api/ocr/matches?${withCursor(params, pageParam)}`),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
        placeholderData: (previous) => previous,
    });
};

export const useOcrMatchItems = (textNorm: string, enabled = true) => {
    const params = query({ textNorm });

    return useInfiniteQuery({
        queryKey: queryKeys.ocr.matchItems(textNorm, params),
        queryFn: ({ pageParam }) =>
            api<OcrMatchItemPage>(`/api/ocr/matches/items?${withCursor(params, pageParam)}`),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
        enabled,
    });
};

/**
 * After a match decision: what any OCR action reaches, and — for one that tagged or untagged
 * items — everything a bulk tag reaches, because that is what it was.
 */
const useMatchMutation = <Input, Result extends { mediaIds: string[] } = OcrMatchResult>(
    path: string,
    tags: boolean
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: Input) =>
            api<Result>(`/api/ocr/${path}`, {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: (result) => {
            afterChange(queryClient, result.mediaIds);

            if (tags) {
                invalidateVocabulary(queryClient);
            }
        },
    });
};

export const useAcceptOnItem = () => useMatchMutation<OcrQueueAcceptInput>("queue/accept", true);
export const useSkipOnItem = () => useMatchMutation<OcrQueueSkipInput>("queue/skip", false);
export const useRejectOcrMatch = () =>
    useMatchMutation<OcrMatchDecideInput>("matches/reject", false);
export const useUndoOcrMatch = () => useMatchMutation<OcrMatchDecideInput>("matches/undo", true);
export const useManualOcrMatch = () =>
    useMatchMutation<OcrMatchManualInput>("matches/manual", true);
export const useUndoRuleTag = () =>
    useMatchMutation<OcrRuleTagUndoInput, OcrChangeResult>("rules/tags/undo", true);

/** How OCR reads, and how much of the library predates the current settings (§5d). */
export const useOcrSettings = () =>
    useQuery({
        queryKey: queryKeys.ocr.settings(),
        queryFn: () => api<OcrSettingsView>("/api/ocr/settings"),
    });

export const useSaveOcrSettings = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (settings: OcrSettings) =>
            api<OcrSettingsView>("/api/ocr/settings", {
                method: "PUT",
                body: JSON.stringify(settings),
            }),
        // The response is the new view, outdated count included; nothing else reads it.
        onSuccess: (next) => queryClient.setQueryData(queryKeys.ocr.settings(), next),
    });
};

/** How often the bench looks again while a comparison is running. */
const BENCH_POLL_MS = 3000;

/**
 * The test bench (§5d). Polls while any trial is waiting or running, and stops when none is,
 * so an idle bench costs nothing.
 */
export const useOcrBench = () =>
    useQuery({
        queryKey: queryKeys.ocr.bench(),
        queryFn: () => api<OcrBench>("/api/ocr/bench"),
        refetchInterval: (query) =>
            query.state.data?.items.some((item) =>
                [item.current, item.candidate].some(
                    (side) => side?.state === "pending" || side?.state === "running"
                )
            )
                ? BENCH_POLL_MS
                : false,
    });

const useBenchMutation = <Input>(path: string, method: "POST" | "PUT") => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: Input) => api<OcrBench>(path, { method, body: JSON.stringify(input) }),
        /**
         * Shown at once from the response, then fetched again.
         *
         * The fetch is not redundant. `refetchInterval` is worked out when a fetch completes,
         * and writing the response into the cache is not one — so a bench that was idle when
         * it loaded stayed idle after Compare, showing "Waiting" until the page was reloaded.
         * Invalidating makes the fetch that sees the pending trials and starts the polling.
         */
        onSuccess: (bench) => {
            queryClient.setQueryData(queryKeys.ocr.bench(), bench);
            void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.bench() });
        },
    });
};

export const useSetOcrTestSet = () =>
    useBenchMutation<{ mediaIds: string[] }>("/api/ocr/bench", "PUT");

export const useAddToOcrTestSet = () =>
    useBenchMutation<{ mediaIds: string[] }>("/api/ocr/bench/add", "POST");

export const useRunOcrTrials = () =>
    useBenchMutation<{ candidate: OcrSettings }>("/api/ocr/bench/run", "POST");

/** Say what a nominated video should read. The estimate changes with it, so that is refetched. */
export const useSetOcrExpected = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: OcrExpectedInput) =>
            api<OcrBench>("/api/ocr/bench/expected", {
                method: "PUT",
                body: JSON.stringify(input),
            }),
        onSuccess: (bench) => {
            queryClient.setQueryData(queryKeys.ocr.bench(), bench);
            void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.tuneEstimates() });
        },
    });
};

/** How often the tuning panel looks again while a run goes. */
const TUNE_POLL_MS = 2000;

/** The latest tuning run (§5d). Polls while it is pending or running, and not otherwise. */
export const useOcrTune = () =>
    useQuery({
        queryKey: queryKeys.ocr.tune(),
        queryFn: () => api<TuneView>("/api/ocr/tune"),
        refetchInterval: (query) => {
            const state = query.state.data?.latest?.state;

            return state === "pending" || state === "running" ? TUNE_POLL_MS : false;
        },
    });

export const useOcrTuneEstimate = (runState: string) =>
    useQuery({
        queryKey: queryKeys.ocr.tuneEstimate(runState),
        queryFn: () => api<TuneEstimates>("/api/ocr/tune/estimate"),
    });

const useTuneMutation = <Input>(path: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: Input) =>
            api<TuneView>(path, { method: "POST", body: JSON.stringify(input) }),
        // Written, then fetched: polling is worked out when a fetch completes (see the bench).
        onSuccess: (view) => {
            queryClient.setQueryData(queryKeys.ocr.tune(), view);
            void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.tune() });
        },
    });
};

export const useStartOcrTune = () => useTuneMutation<TuneStartInput>("/api/ocr/tune");

export const useStopOcrTune = () => useTuneMutation<Record<string, never>>("/api/ocr/tune/stop");
