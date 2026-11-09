"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    AddReelItemsInput,
    BulkClipUntagInput,
    BulkClipUntagResult,
    ClipMarksInput,
    Clip,
    ClipDetail,
    ClipQuery,
    CreateClipInput,
    CreateReelInput,
    Reel,
    ReelItemsResponse,
    ReelListResponse,
    ReelQuery,
    UpdateClipInput,
    UpdateReelInput,
} from "@private-stock/core";

import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateVocabulary } from "@/lib/api/tags";
import { api } from "./client";

/**
 * Clips and reels, client side (§14d).
 *
 * Every key is built by calling the factory. Nothing here writes an array out, including in a
 * local helper one line above its use — `lib/api/playlists.ts` did exactly that and the lint
 * missed it: that walks the source for keys written out as array literals, and a helper one
 * line above the call is not one.
 *
 * The invalidations are deliberately broad in one place and narrow everywhere else. Retiming a
 * clip reaches `reels.all()` rather than the reels the response named, because the span is not
 * copied: every reel holding it now runs for a different length, and the index draws that on
 * each card. `docs/CACHE_KEYS.md` §2 carries the reasoning.
 */

const serialise = (query: Partial<ReelQuery> | Partial<ClipQuery>): string =>
    new URLSearchParams(
        Object.entries(query)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)])
    ).toString();

/* ── Reels ─────────────────────────────────────────────────────────────────────────────── */

export const useReels = (query: Partial<ReelQuery>) => {
    const params = serialise(query);

    return useQuery({
        queryKey: queryKeys.reels.list(params, query.page ?? 0),
        queryFn: () => api<ReelListResponse>(`/api/reels?${params}`),
        // Keeps the current page on screen while the next loads, so paging does not flash an
        // empty wall — the same choice the library grid makes.
        placeholderData: (previous) => previous,
    });
};

/** Reels this account could add a clip to, newest first. What "Add to reel" offers. */
export const useOwnReels = () => useReels({ ownership: "mine", sort: "updated", limit: 50 });

export const useReel = (reelId: string) =>
    useQuery({
        queryKey: queryKeys.reels.detail(reelId),
        queryFn: () => api<Reel>(`/api/reels/${reelId}`),
        enabled: reelId !== "",
    });

/**
 * The whole reel, in order.
 *
 * No page argument, unlike a playlist's items: a reel is played in one pass, and a player that
 * had to fetch a second page part way through would stall at a join.
 */
export const useReelItems = (reelId: string) =>
    useQuery({
        queryKey: queryKeys.reels.items(reelId),
        queryFn: () => api<ReelItemsResponse>(`/api/reels/${reelId}/items`),
        enabled: reelId !== "",
    });

/**
 * Everything that writes a reel.
 *
 * The reel prefix, because the index is paged and sorted: a rename can move a reel onto a page
 * this client has never fetched, so invalidating one page's key would leave the others
 * confidently wrong.
 *
 * **And the clips, which is less obvious.** A clip's row says how many reels it is in, so a
 * reel's *existence* is part of what the browser draws: creating one with clips already in it
 * raises their count, and deleting one lowers every member's. Without this the badges were
 * stale the moment the thing they counted was made.
 */
const useReelMutation = <TArgs, TResult>(
    request: (args: TArgs) => Promise<TResult>,
    onDone?: (result: TResult, args: TArgs) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: (result, args) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.reels.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.clips.all() });
            onDone?.(result, args);
        },
    });
};

export const useCreateReel = (onCreated?: (reel: Reel) => void) =>
    useReelMutation(
        (input: CreateReelInput) =>
            api<Reel>("/api/reels", { method: "POST", body: JSON.stringify(input) }),
        (reel) => onCreated?.(reel)
    );

export const useUpdateReel = () =>
    useReelMutation(({ id, patch }: { id: string; patch: UpdateReelInput }) =>
        api<Reel>(`/api/reels/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
    );

export const useDeleteReel = (onDeleted?: () => void) =>
    useReelMutation(
        (id: string) => api<{ ok: true }>(`/api/reels/${id}`, { method: "DELETE" }),
        () => onDeleted?.()
    );

/**
 * Membership changes, which also move the browser's "not in a reel yet" answer.
 *
 * `clips.all()` as well as the reel, because the browser draws how many reels each clip is in
 * and that column is what keeps adding and discarding from being silent.
 */
const useReelItemsMutation = <TArgs>(request: (args: TArgs) => Promise<ReelItemsResponse>) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.reels.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.clips.all() });
        },
    });
};

export const useAddReelItems = () =>
    useReelItemsMutation(({ id, input }: { id: string; input: AddReelItemsInput }) =>
        api<ReelItemsResponse>(`/api/reels/${id}/items`, {
            method: "POST",
            body: JSON.stringify(input),
        })
    );

export const useRemoveReelItem = () =>
    useReelItemsMutation(({ id, itemId }: { id: string; itemId: string }) =>
        api<ReelItemsResponse>(`/api/reels/${id}/items/${itemId}`, { method: "DELETE" })
    );

export const useMoveReelItem = () =>
    useReelItemsMutation(
        ({ id, itemId, toIndex }: { id: string; itemId: string; toIndex: number }) =>
            api<ReelItemsResponse>(`/api/reels/${id}/items`, {
                method: "PATCH",
                body: JSON.stringify({ itemId, toIndex }),
            })
    );

/* ── Clips ─────────────────────────────────────────────────────────────────────────────── */

/** Labels this person has used before, so a clip's name is offered rather than retyped. */
export const useClipLabels = () =>
    useQuery({
        queryKey: queryKeys.clips.labels(),
        queryFn: () => api<{ labels: string[] }>("/api/clips/labels"),
        staleTime: 60_000,
    });

/** One clip with the reels holding it named — what a retime or a discard has to say first. */
export const useClipDetail = (clipId: string | null) =>
    useQuery({
        queryKey: queryKeys.clips.detail(clipId ?? ""),
        queryFn: () => api<ClipDetail>(`/api/clips/${clipId}`),
        enabled: clipId !== null,
    });

/**
 * Everything that writes a clip.
 *
 * Three caches, and the reel prefix is the one that matters: the span is the single source of
 * truth, so retiming it changes every reel holding it and the client cannot narrow that to the
 * reels it happens to have fetched.
 */
const useClipMutation = <TArgs, TResult>(
    request: (args: TArgs) => Promise<TResult>,
    mediaIdOf: (args: TArgs, result: TResult) => string | null,
    onDone?: (result: TResult, args: TArgs) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: (result, args) => {
            const mediaId = mediaIdOf(args, result);

            if (mediaId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.media.detail(mediaId) });
            }

            void queryClient.invalidateQueries({ queryKey: queryKeys.clips.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.libraryAll() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.reels.all() });
            onDone?.(result, args);
        },
    });
};

export const useCreateClip = (onCreated?: (clip: Clip) => void) => {
    const queryClient = useQueryClient();

    return useClipMutation(
        ({ mediaId, input }: { mediaId: string; input: CreateClipInput }) =>
            api<Clip>(`/api/media/${mediaId}/clips`, {
                method: "POST",
                body: JSON.stringify(input),
            }),
        (args) => args.mediaId,
        (clip, args) => {
            // A clip saved with tags may have coined names; the suggestion lists pick them up
            // next time a box opens, as after a chip (`itemTags.ts`).
            if (args.input.tags?.length) {
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.tags.all(),
                    refetchType: "none",
                });
            }

            onCreated?.(clip);
        }
    );
};

export const useUpdateClip = () =>
    useClipMutation(
        ({ id, patch }: { id: string; patch: UpdateClipInput }) =>
            api<Clip>(`/api/clips/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
        (_args, result) => result.mediaId
    );

export const useDeleteClip = (onDeleted?: (reelsChanged: number) => void) =>
    useClipMutation(
        ({ id }: { id: string; mediaId: string }) =>
            api<{ reelsChanged: number }>(`/api/clips/${id}`, { method: "DELETE" }),
        (args) => args.mediaId,
        (result) => onDeleted?.(result.reelsChanged)
    );

/**
 * Takes tags off ticked clips (§14d "Tagging clips").
 *
 * `invalidateVocabulary`, as tagging a selection of clips does: a removal can retire the tag
 * (`pruneUnused`), and that reaches `clips.all()` -- the wall's cards, its facet chips and the
 * selection read the dialogue was built from. See docs/CACHE_KEYS.md.
 */
export const useUntagClips = (onDone: (result: BulkClipUntagResult) => void) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: BulkClipUntagInput) =>
            api<BulkClipUntagResult>("/api/clips/bulk/untag", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: (result) => {
            invalidateVocabulary(queryClient);
            onDone(result);
        },
    });
};

/**
 * Stars or a heart on your clips (§14d "Clips in the library"). The library's tabs draw them, and
 * the Clips tab's rating filter reads them, so its lists refetch.
 */
export const useMarkClips = (onDone?: () => void) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: ClipMarksInput) =>
            api<{ changed: number }>("/api/clips/bulk/marks", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.clips.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.libraryAll() });
            onDone?.();
        },
    });
};
