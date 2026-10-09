"use client";

import { useCallback, useState } from "react";
import {
    keepPreviousData,
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
    type InfiniteData,
    type QueryClient,
} from "@tanstack/react-query";

import type {
    FacetKindsResponse,
    SetTagPictureInput,
    TagBrowseResponse,
    TagBrowseSort,
    TagChangeResult,
    TagCompanionsResponse,
    TagPicture,
    TagProfile,
    TagScope,
    TagSearchResponse,
    VocabularyResponse,
    Tag,
    TagBatch,
    UpdateTagInput,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Reading and changing the tag vocabulary (§6).
 *
 * One module rather than a `useMutation` in each dialogue, following `playlists.ts` and
 * `savedFilters.ts`: the interesting part of a vocabulary change is not the request but **what
 * it invalidates**, and that is identical for every one of them. Written per-dialogue it would
 * be six copies of a three-key cascade, and the one that drifts is the one where a rename
 * leaves the old name on the chips until a reload.
 */

/**
 * Everything a vocabulary change moves.
 *
 * Four strokes, and none is optional:
 *
 * - `tags.all()` — the suggestion lists, the management table and the batch history.
 * - `media.facets()` — every filter panel's chips and counts, per filter, all of them.
 * - `media.all()` — tags are a membership test as well as a property, so a merge or a delete
 *   changes which page an item belongs on (`docs/CACHE_KEYS.md` §2).
 * - `clips.all()` — clips carry the same tags, and /clips filters on them (§14d).
 *
 * The item detail is reached by `media.all()`'s prefix, which is why it is not listed again.
 */
export const invalidateVocabulary = (queryClient: QueryClient): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags.all() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.media.facets() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
    // Clips carry the same vocabulary (§14d), so a rename, merge or delete changes their chips
    // and the browser's tag fields too -- and an undone batch may have been a batch of clips.
    void queryClient.invalidateQueries({ queryKey: queryKeys.clips.all() });
};

/**
 * One facet's vocabulary, for the box somebody is typing a name into.
 *
 * `GET /api/tags?kind=` has always answered this — count-ordered, capped, one facet and one
 * system per request — and exactly one box in the app used it. It lives here rather than
 * inside a component so the three that need it share a cache entry instead of three.
 *
 * `enabled` is the caller's: the dialogues open onto a focused box and want it at once, while
 * the detail drawer draws a box per facet and would otherwise fire five requests for
 * autocomplete nobody has asked for, on a NAS, on a page whose real job is playing a video.
 *
 * Keyed by scope as well as facet. One entry for both would offer a public name in the private
 * box, where typing it coins a private tag of that name rather than reusing the one suggested
 * (§6).
 */
export const useTagSuggestions = (kind: string, scope: TagScope, enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.tags.byKind(kind, scope),
        queryFn: () =>
            api<{ tags: Tag[] }>(`/api/tags?kind=${encodeURIComponent(kind)}&scope=${scope}`),
        enabled,
        /**
         * Revalidated every time a box asks, and whenever the window comes back.
         *
         * A name coined in this tab arrives through `tags.all()`. One coined in another tab,
         * or by somebody else, has nothing to invalidate here — and with five minutes of
         * freshness and the app's refetch-on-focus off, the other tab went on offering the old
         * list, so the new name was typed again by hand and the box looked broken. The cached
         * list still shows at once; the refetch only fills in behind it, and it is one capped,
         * count-ordered read per box opened.
         */
        staleTime: 0,
        refetchOnWindowFocus: true,
    });

/**
 * One facet's names matching what is typed into a tag box, best match first (§5b "One rule for
 * names"). The server searches the whole vocabulary by its rule and orders the matches; the box
 * shows them as they come. `typed` arrives debounced, and the previous answer stays on screen
 * while the next is asked for, so the list does not blank between keystrokes.
 */
export const useTagSearch = (kind: string, scope: TagScope, typed: string, enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.tags.search(kind, scope, typed),
        queryFn: () =>
            api<TagSearchResponse>(
                `/api/tags?kind=${encodeURIComponent(kind)}&scope=${scope}&q=${encodeURIComponent(typed)}&limit=50`
            ),
        enabled: enabled && typed !== "",
        placeholderData: keepPreviousData,
        // A name coined in another tab or by somebody else has nothing to invalidate here.
        staleTime: 0,
    });

/**
 * Every facet that has a tag in it, known ones first.
 *
 * The management screen draws the known facets whether or not they have anything in them;
 * this is how it finds the rest -- a facet a scraper invented, which would otherwise have no
 * section and so no way to be tidied.
 */
export const useFacetKinds = () =>
    useQuery({
        queryKey: queryKeys.tags.kinds(),
        queryFn: () => api<FacetKindsResponse>("/api/tags"),
    });

export interface VocabularyFilters {
    scope: TagScope;
    kind: string;
    search?: string;
    unusedOnly?: boolean;
    sort?: "count" | "name";
    page: number;
    pageSize: number;
}

const vocabularyParams = (filters: VocabularyFilters): URLSearchParams => {
    const params = new URLSearchParams({
        scope: filters.scope,
        limit: String(filters.pageSize),
        offset: String(filters.page * filters.pageSize),
    });

    params.set("kind", filters.kind);
    if (filters.search) params.set("search", filters.search);
    if (filters.unusedOnly) params.set("unusedOnly", "true");
    if (filters.sort) params.set("sort", filters.sort);

    return params;
};

/**
 * `enabled` is for the merge dialogue, which lives on every row of a list: it wants targets
 * only once somebody opens it, not a request per row on the way in.
 */
export const useVocabulary = (filters: VocabularyFilters, enabled = true) => {
    const params = vocabularyParams(filters);

    return useQuery({
        queryKey: queryKeys.tags.list(filters.scope, params.toString()),
        queryFn: () => api<VocabularyResponse>(`/api/tags/vocabulary?${params.toString()}`),
        enabled,
        // Paging a long vocabulary should not flash an empty table between pages, the same
        // reason the grid and playlist items keep the previous page.
        placeholderData: (previous) => previous,
    });
};

export interface TagBrowseFilters {
    kind: string;
    scope: TagScope;
    search?: string;
    sort: TagBrowseSort;
    seed: number;
    /** Only the viewer's favourites. */
    favorite?: boolean;
}

/**
 * A browse page, loaded a page of rows at a time as it scrolls (§6 "Tags").
 *
 * Infinite rather than paged: this is a wall of people to scroll past, not a table to jump
 * around in, and page numbers under a list of faces are a question nobody is asking.
 */
export const useTagBrowse = (filters: TagBrowseFilters) => {
    const params = new URLSearchParams({
        kind: filters.kind,
        scope: filters.scope,
        sort: filters.sort,
        seed: String(filters.seed),
    });

    if (filters.search) params.set("search", filters.search);
    if (filters.favorite) params.set("favorite", "1");

    return useInfiniteQuery({
        queryKey: queryKeys.tags.browse(filters.kind, filters.scope, params.toString()),
        queryFn: ({ pageParam }) =>
            api<TagBrowseResponse>(`/api/tags/browse?${params.toString()}&page=${pageParam}`),
        initialPageParam: 0,
        getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
        // A new search should not blank the list while it loads, the vocabulary table's reason.
        placeholderData: (previous) => previous,
    });
};

export const useTagProfile = (tagId: string, seed: number) =>
    useQuery({
        queryKey: queryKeys.tags.profile(tagId, seed),
        queryFn: () => api<TagProfile>(`/api/tags/${encodeURIComponent(tagId)}?seed=${seed}`),
    });

/**
 * "Appears with" on a tag's page, asked for on its own (§6 "Tags", §20).
 *
 * `enabled` is the page's: true once the profile has drawn, the tag is a library performer and
 * the section is near the viewport. It used to be part of the profile, and every visit waited
 * on it -- with the web process stopped for everyone else while it was read.
 *
 * Fresh for ten minutes rather than the app's half-minute: who appears with whom moves only
 * when somebody tags, renames, merges or deletes, and each of those reaches this key through
 * `tags.all()`; a trash, restore or purge reaches it through `invalidateListable`. Coming back
 * to a performer within a visit should not ask again.
 */
export const useTagCompanions = (tagId: string, seed: number, enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.tags.companions(tagId, seed),
        queryFn: () =>
            api<TagCompanionsResponse>(
                `/api/tags/${encodeURIComponent(tagId)}/companions?seed=${seed}`
            ),
        enabled,
        staleTime: 10 * 60_000,
    });

/**
 * This viewer's favourite mark on one tag (§6 "Favourite tags").
 *
 * Not a vocabulary change, so not `invalidateVocabulary`: nothing about the tag itself moved.
 * What moves is everything that reads the mark: the browse lists (a "Favourites only" list
 * gains or loses the row), the tag's own page, the library panel's Favourites ♥ counts, and
 * any grid filtered by "my favourite performers" -- that filter is resolved live (§14e), so a
 * new favourite is a new member of it.
 *
 * The answer is written into both before they refetch, for `useUserMedia`'s reason: a heart
 * showing the sent value only while the request is in flight un-presses itself for a round
 * trip between the response and the refetch.
 *
 * Returns what a heart needs rather than the mutation: the value to show (the one in flight,
 * else `stored`), the toggle, and the burst for a new favourite. The row and the profile are
 * two hearts, and a second copy of "which value is current" is a second chance to get it wrong.
 */
export const useTagFavorite = (tagId: string, stored: boolean) => {
    const queryClient = useQueryClient();
    const [burstKey, setBurstKey] = useState<number | null>(null);

    const mutation = useMutation({
        mutationFn: (favorite: boolean) =>
            api<{ favorite: boolean }>(`/api/tags/${encodeURIComponent(tagId)}/user`, {
                method: "PATCH",
                body: JSON.stringify({ favorite }),
            }),
        onSuccess: ({ favorite }) => {
            queryClient.setQueriesData<TagProfile>(
                { queryKey: queryKeys.tags.profileOf(tagId) },
                (current) => (current ? { ...current, favorite } : current)
            );
            queryClient.setQueriesData<InfiniteData<TagBrowseResponse>>(
                { queryKey: queryKeys.tags.browseAll() },
                (current) =>
                    current && {
                        ...current,
                        pages: current.pages.map((page) => ({
                            ...page,
                            rows: page.rows.map((row) =>
                                row.tag.id === tagId ? { ...row, favorite } : row
                            ),
                        })),
                    }
            );

            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.browseAll() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.facets() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
        },
    });

    const favorite = mutation.isPending ? mutation.variables : stored;

    const toggle = useCallback(() => {
        if (!favorite) {
            setBurstKey(Date.now());
        }

        mutation.mutate(!favorite);
    }, [favorite, mutation]);

    return { favorite, toggle, burstKey };
};

/**
 * Choosing a tag's picture, or taking the choice back (§6 "A tag's picture").
 *
 * The picture is drawn wherever the tag is: its browse row and tile, its page, the companions
 * rows, the tag boxes' suggestions, Review › Faces and every item carrying it. So `tags.all()` and
 * `media.all()` -- the item detail is under that prefix -- and nothing narrower; a picture is
 * chosen rarely, and a stale one on any of those reads as the choice not having worked.
 */
const useTagPictureMutation = <V>(
    request: (variables: V) => Promise<{ picture: TagPicture | null }>,
    onDone?: (picture: TagPicture | null) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: ({ picture }) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
            onDone?.(picture);
        },
    });
};

export const useSetTagPicture = (tagId: string, onDone?: (picture: TagPicture | null) => void) =>
    useTagPictureMutation(
        (input: SetTagPictureInput) =>
            api<{ picture: TagPicture }>(`/api/tags/${encodeURIComponent(tagId)}/picture`, {
                method: "PUT",
                body: JSON.stringify(input),
            }),
        onDone
    );

export const useClearTagPicture = (tagId: string, onDone?: (picture: TagPicture | null) => void) =>
    useTagPictureMutation(
        () =>
            api<{ picture: TagPicture | null }>(`/api/tags/${encodeURIComponent(tagId)}/picture`, {
                method: "DELETE",
            }),
        onDone
    );

/**
 * One mutation shape for every vocabulary change.
 *
 * `onDone` rather than a return value, because each dialogue closes itself and reports its own
 * sentence — "412 items" reads differently after a merge than after a delete.
 */
const useVocabularyMutation = <TVariables, TResult>(
    request: (variables: TVariables) => Promise<TResult>,
    onDone?: (result: TResult) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: (result) => {
            invalidateVocabulary(queryClient);
            onDone?.(result);
        },
    });
};

/** An edit as the route validates it, plus the tag it is for. */
type TagEdit = UpdateTagInput & { id: string };

export const useUpdateTag = (onDone?: (tag: Tag) => void) =>
    useVocabularyMutation(
        ({ id, ...changes }: TagEdit) =>
            api<Tag>(`/api/tags/${id}`, { method: "PATCH", body: JSON.stringify(changes) }),
        onDone
    );

export const useDeleteTag = (onDone?: (result: TagChangeResult) => void) =>
    useVocabularyMutation(
        (id: string) => api<TagChangeResult>(`/api/tags/${id}`, { method: "DELETE" }),
        onDone
    );

export const useMergeTags = (onDone?: (result: TagChangeResult) => void) =>
    useVocabularyMutation(
        ({ id, intoTagId, keepAlias }: { id: string; intoTagId: string; keepAlias: boolean }) =>
            api<TagChangeResult>(`/api/tags/${id}/merge`, {
                method: "POST",
                body: JSON.stringify({ intoTagId, keepAlias }),
            }),
        onDone
    );

/**
 * Publishing and unpublishing, which also move what other people's searches find.
 *
 * Public tags are in the search document and private ones are not, so this is the one
 * vocabulary change whose effect reaches accounts that were not looking at it (§5c). The
 * reindex is the server's; the cascade here is the same as every other change.
 */
export const useSetTagScope = (onDone?: (result: TagChangeResult) => void) =>
    useVocabularyMutation(
        ({ id, scope }: { id: string; scope: TagScope }) =>
            api<TagChangeResult>(`/api/tags/${id}/scope`, {
                method: "PUT",
                body: JSON.stringify({ scope }),
            }),
        onDone
    );

export const useTagBatches = () =>
    useQuery({
        queryKey: queryKeys.tags.batches(),
        queryFn: () => api<{ batches: TagBatch[] }>("/api/tags/bulk/batches"),
    });

export const useUndoBatch = (onDone?: (result: { removed: number }) => void) =>
    useVocabularyMutation(
        (id: string) =>
            api<{ removed: number }>(`/api/tags/bulk/batches/${id}`, { method: "DELETE" }),
        onDone
    );

/**
 * "Not them", from "Find untagged" (§5d): the items leave the filter and the performer's
 * "Likely", and the filter's counts move. See docs/CACHE_KEYS.md.
 */
export const useRefuseMentions = (tagId: string | null) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (mediaIds: string[]) =>
            api<{ refused: number }>(`/api/tags/${encodeURIComponent(tagId ?? "")}/mentions`, {
                method: "POST",
                body: JSON.stringify({ mediaIds }),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.facets() });

            if (tagId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.tags.likely(tagId) });
            }
        },
    });
};
