"use client";

import { useCallback } from "react";
import {
    queryOptions,
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";

import type {
    NoSingleFace,
    ItemPeople,
    ItemPeopleDecision,
    AutoTagDecision,
    AutoTagPage,
    AutoTagState,
    AutoTagSwitch,
    ConfirmedFacesPage,
    FaceComparison,
    FaceHistoryPage,
    FaceMoments,
    FaceReviewFace,
    FaceSearch,
    FaceSearchMatches,
    FaceSearchName,
    FaceSearchStart,
    NewPeopleDecision,
    NewPeoplePage,
    PerformerPeopleDecision,
    PerformerPeoplePage,
    SuggestionDecision,
    SuggestionPerformers,
    SuggestionsPage,
    FaceUndo,
    ReviewMedia,
} from "@private-stock/core";

import { ApiError, api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateVocabulary } from "@/lib/api/tags";

/**
 * Faces (§5f): Suggestions, New people, History, a performer's Faces tab, People in this item and
 * Would tag. See docs/CACHE_KEYS.md.
 */

const base = (tagId: string): string => `/api/tags/${encodeURIComponent(tagId)}`;

/**
 * Every face confirmed as them, a page at a time, for choosing their picture: asked for only
 * while the choosing is open.
 */
export const useConfirmedFaces = (tagId: string, enabled: boolean) =>
    useInfiniteQuery({
        queryKey: queryKeys.tags.confirmedFaces(tagId),
        queryFn: ({ pageParam }) =>
            api<ConfirmedFacesPage>(`${base(tagId)}/faces/confirmed?page=${pageParam}`),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
        enabled,
    });

/**
 * Their face from a few of their items, for "Look" beside one that may be them: asked for when
 * the look opens, then shared by every card of theirs for a while. See docs/CACHE_KEYS.md.
 */
export const useFaceComparison = (tagId: string) =>
    useQuery({
        queryKey: queryKeys.tags.faceComparison(tagId),
        queryFn: () => api<FaceComparison>(`${base(tagId)}/faces/compare`),
        staleTime: 10 * 60 * 1000,
    });

/** "Would tag", a page at a time, in the visit's order. See docs/CACHE_KEYS.md. */
export const useAutoTags = (state: AutoTagState, seed: number) =>
    useInfiniteQuery({
        queryKey: queryKeys.tags.autoTags(state, seed),
        queryFn: ({ pageParam }) =>
            api<AutoTagPage>(`/api/faces/auto?state=${state}&seed=${seed}&page=${pageParam}`),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
    });

/**
 * "Right" or "Wrong" of one item. Right tags it, so it moves what any tagging does; either moves
 * the review and the performer's faces.
 */
export const useDecideAutoTag = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: AutoTagDecision) =>
            api<{ tagged: number }>("/api/faces/auto", {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: (_, decision) => {
            if (decision.verdict === "right") {
                invalidateVocabulary(queryClient);
            } else {
                void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faceReviewAll() });
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.tags.faces(decision.tagId),
                });
            }
        },
    });
};

/** Let faces tag by themselves, or stop them: the list says which, so it is asked again. */
export const useSwitchAutoTag = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: AutoTagSwitch) =>
            api<{ enabled: boolean }>("/api/faces/auto/setting", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: () =>
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faceReviewAll() }),
    });
};

/** People in this item (§5f), for administrators. */
export const useItemPeople = (mediaId: string, enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.media.people(mediaId),
        queryFn: () => api<ItemPeople>(`/api/media/${encodeURIComponent(mediaId)}/people`),
        enabled,
    });

/**
 * Say who a person in the item is, or is not, or tag or refuse a performer its text names. Tagging
 * is a tag edit like any other, so it moves what any does — the item and who is in it among it;
 * either way History lists it.
 */
export const useDecideItemPeople = (mediaId: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: ItemPeopleDecision) =>
            api<{ changed: number }>(`/api/media/${encodeURIComponent(mediaId)}/people`, {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: () => {
            invalidateVocabulary(queryClient);
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.people(mediaId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
        },
    });
};

/** While the worker reads a frame, how often to ask whether it has finished. */
const FACE_SEARCH_POLL_MS = 1500;

/** Who is this? (§5f): search the library's faces from the frame on screen. */
export const useStartFaceSearch = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: FaceSearchStart) =>
            api<FaceSearch>("/api/faces/search", { method: "POST", body: JSON.stringify(input) }),
        onSuccess: (search) =>
            queryClient.setQueryData(queryKeys.faceSearch.detail(search.id), search),
    });
};

/** A search, asked about again until the worker has answered. */
export const useFaceSearch = (id: string | null) =>
    useQuery({
        queryKey: queryKeys.faceSearch.detail(id ?? ""),
        queryFn: () => api<FaceSearch>(`/api/faces/search/${encodeURIComponent(id!)}`),
        enabled: id !== null,
        refetchInterval: (query) => {
            const state = query.state.data?.state;

            return state === "pending" || state === "running" ? FACE_SEARCH_POLL_MS : false;
        },
    });

/** The items most like one face on the frame. Fixed once the search is done. */
export const useFaceSearchMatches = (id: string | null, index: number | null) =>
    useQuery({
        queryKey: queryKeys.faceSearch.matches(id ?? "", index ?? -1),
        queryFn: () =>
            api<FaceSearchMatches>(`/api/faces/search/${encodeURIComponent(id!)}/faces/${index!}`),
        enabled: id !== null && index !== null,
        staleTime: Infinity,
    });

/**
 * Say who one face on the frame is (§5f "Who is this?"). Tagging is a tag edit like any other, so it
 * moves what any does, and the decision joins History; the candidates are read again for the names
 * their faces are now confirmed as — same scores, so the same order.
 */
export const useNameFromSearch = (id: string, index: number) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: FaceSearchName) =>
            api<{ tagId: string; name: string; tagged: number; refused: number }>(
                `/api/faces/search/${encodeURIComponent(id)}/faces/${index}`,
                { method: "POST", body: JSON.stringify(decision) }
            ),
        onSuccess: () => {
            invalidateVocabulary(queryClient);
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
            void queryClient.invalidateQueries({
                queryKey: queryKeys.faceSearch.matches(id, index),
            });
        },
    });
};

/**
 * "No single face", or taken back: the performer's face section, their "Likely" and the review
 * all change; the references are rebuilt behind it.
 */
export const useSetNoSingleFace = (tagId: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: NoSingleFace) =>
            api<{ noSingleFace: boolean }>(`${base(tagId)}/faces/setting`, {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faces(tagId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faceReviewAll() });
        },
    });
};

/**
 * History (§5f "Decisions you can take back"), a page at a time. Asked for again whenever it is
 * opened: decisions are made on every face surface, and none of them has to reach it.
 */
export const useFaceHistory = (actor: "all" | "user" | "app", tagId: string | null) =>
    useInfiniteQuery({
        queryKey: queryKeys.faceHistory.list(actor, tagId),
        queryFn: ({ pageParam }) =>
            api<FaceHistoryPage>(
                `/api/faces/history?actor=${actor}` +
                    (tagId ? `&tagId=${encodeURIComponent(tagId)}` : "") +
                    (pageParam ? `&before=${encodeURIComponent(pageParam)}` : "")
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
        refetchOnMount: "always",
    });

/**
 * Undo a face decision. Its tags may go with it, so it moves what any tag edit does — every
 * performer's faces and "Likely", the library's pages and facets, the undo list — and History.
 * Not the review's lists, which hold still until refreshed.
 */
export const useUndoFaceDecision = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, ...input }: FaceUndo & { id: string }) =>
            api<{ undone: true }>(`/api/faces/history/${encodeURIComponent(id)}/undo`, {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: () => {
            invalidateVocabulary(queryClient);
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
        },
    });
};

const mediaParam = (media: ReviewMedia): string => (media === "all" ? "" : `media=${media}`);

/** Suggestions' performers, most first (§5f "Suggestions"): asked again whenever shown. */
export const useSuggestionPeople = (media: ReviewMedia) =>
    useQuery({
        queryKey: queryKeys.faceReview.suggestionPeople(media),
        queryFn: () =>
            api<SuggestionPerformers>(`/api/faces/suggestions/people?${mediaParam(media)}`),
        refetchOnMount: "always",
    });

/**
 * One performer's suggestions, a page at a time. Holds still while it is worked: a decision
 * settles its cards in place, and nothing fetches it again until a new `visit`.
 */
export const useSuggestions = (tagId: string, media: ReviewMedia, visit: number) =>
    useInfiniteQuery({
        queryKey: queryKeys.faceReview.suggestions(tagId, media, visit),
        queryFn: ({ pageParam }) =>
            api<SuggestionsPage>(
                `/api/faces/suggestions?tagId=${encodeURIComponent(tagId)}&${mediaParam(media)}` +
                    (pageParam ? `&after=${encodeURIComponent(pageParam)}` : "")
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.next,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });

/**
 * Say who the people on a page of cards are. Tagging is a tag edit like any other, so it moves
 * what any does; History lists it. The cards themselves are settled in place by the page.
 */
export const useDecideSuggestions = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: SuggestionDecision) =>
            api<{ tagged: number; refused: number }>("/api/faces/suggestions", {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: () => {
            invalidateVocabulary(queryClient);
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
        },
    });
};

/** One section of a performer's Faces tab, a page at a time; holds still until a new `visit`. */
export const usePerformerPeople = (
    tagId: string,
    section: "confirmed" | "items" | "ruledOut",
    all: boolean,
    visit: number
) =>
    useInfiniteQuery({
        queryKey: queryKeys.faceReview.performerPeople(tagId, section, all, visit),
        queryFn: ({ pageParam }) =>
            api<PerformerPeoplePage>(
                `${base(tagId)}/faces/people?section=${section}&page=${pageParam}` +
                    (all ? "&all=true" : "")
            ),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });

/**
 * Take back, pick or restore a page of a performer's cards. Their faces move — the picture's
 * choices, "Likely" — and History; the cards are settled in place by the tab.
 */
export const useDecidePerformerPeople = (tagId: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: PerformerPeopleDecision) =>
            api<{ changed: number }>(`${base(tagId)}/faces/people`, {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faces(tagId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
        },
    });
};

/** New people (§5f), a page at a time; holds still until a new `visit`. */
export const useNewPeople = (visit: number) =>
    useInfiniteQuery({
        queryKey: queryKeys.faceReview.newPeople(visit),
        queryFn: ({ pageParam }) => api<NewPeoplePage>(`/api/faces/new-people?page=${pageParam}`),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });

/**
 * Name a new person, or say they are not one person, or later. Naming tags items and may coin a
 * performer, so it moves what any vocabulary change does; History lists it either way. The block
 * itself is settled in place by the page.
 */
export const useDecideNewPeople = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: NewPeopleDecision) =>
            api<{ changed: number; name: string | null }>("/api/faces/new-people", {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: () => {
            invalidateVocabulary(queryClient);
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
        },
    });
};

/**
 * The frames a video's face may really be, and the one its sprite tile looks like (§9 "What a
 * tile shows"): stated once, for the picture dialogue to ask and the item page to fetch. Never
 * stale: read from the file and its sheets, which nothing here changes. See docs/CACHE_KEYS.md.
 */
export const faceMomentsQuery = (mediaId: string, atMs: number) =>
    queryOptions({
        queryKey: queryKeys.faceMoments(mediaId, atMs),
        queryFn: () =>
            api<FaceMoments>(
                `/api/media/${encodeURIComponent(mediaId)}/moments?at=${Math.max(0, Math.round(atMs))}`
            ),
        staleTime: Infinity,
        // Only when the frame ceiling was full (§9): anything else will not read better twice.
        retry: (failures, error) =>
            failures < 2 && error instanceof ApiError && error.status === 429,
        retryDelay: 2000,
    });

/** The face's real moment: the matched frame, or its own time when none could be told. */
export const matchedMoment = (moments: FaceMoments | undefined, atMs: number): number =>
    moments && moments.matched !== null ? moments.moments[moments.matched].atMs : atMs;

/**
 * Going to a video's face: to the frame it was really seen in, or to its own moment when that
 * cannot be told -- a face is still worth going to on a guess. Asked when pressed, not before:
 * most presses of a face's menu answer whether it is them, and each ask reads the file.
 */
export const useSeekToFace = (onSeek: (atMs: number) => void) => {
    const queryClient = useQueryClient();

    return useCallback(
        (face: FaceReviewFace): void => {
            if (face.kind !== "video" || face.atMs === null) {
                return;
            }

            const atMs = face.atMs;

            queryClient.fetchQuery(faceMomentsQuery(face.mediaId, atMs)).then(
                (moments) => onSeek(matchedMoment(moments, atMs)),
                () => onSeek(atMs)
            );
        },
        [queryClient, onSeek]
    );
};
