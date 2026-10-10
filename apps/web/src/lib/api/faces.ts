"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    NoSingleFace,
    ItemPeople,
    ItemPeopleDecision,
    AutoTagDecision,
    AutoTagPage,
    AutoTagState,
    AutoTagSwitch,
    FaceLikeness,
    FacePeek,
    ConfirmedFacesPage,
    FaceReviewDecision,
    FaceReviewPage,
    FaceReviewResult,
    FaceReviewTab,
    FaceHistoryPage,
    PerformerPeopleDecision,
    PerformerPeoplePage,
    SuggestionDecision,
    SuggestionPerformers,
    SuggestionsPage,
    FaceUndo,
    LikelyDecision,
    LikelyPage,
    ReviewMedia,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateVocabulary } from "@/lib/api/tags";

/**
 * A performer's faces and "Likely" list (§5f "Starting from the performer"). See
 * docs/CACHE_KEYS.md "Faces on a performer's page".
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

/** "Likely", a page at a time: a long list is read down and acted on, not loaded whole. */
export const useLikely = (tagId: string, enabled: boolean) =>
    useInfiniteQuery({
        queryKey: queryKeys.tags.likely(tagId),
        queryFn: ({ pageParam }) => api<LikelyPage>(`${base(tagId)}/likely?page=${pageParam}`),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
        enabled,
    });

/**
 * Tag items from "Likely", or say one is not them. Tagging is a tag edit like any other — the
 * library's pages, counts and facets move, and the batch joins the undo list — and the page's
 * own counts and groups move with it.
 */
export const useDecideLikely = (tagId: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: LikelyDecision) =>
            api<{ changed: number }>(`${base(tagId)}/likely`, {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: (_, decision) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.likely(tagId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faces(tagId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.faceReviewAll() });

            if (decision.verdict === "refuse") {
                // The name match is refused too: "Find untagged" and its counts move.
                void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
                void queryClient.invalidateQueries({ queryKey: queryKeys.media.facets() });
            } else {
                void queryClient.invalidateQueries({ queryKey: queryKeys.tags.profileOf(tagId) });
                void queryClient.invalidateQueries({ queryKey: queryKeys.tags.batches() });
                void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
            }
        },
    });
};

/**
 * Review › Faces, a page at a time (§5f "A list that holds still"). The first page makes the
 * visit's list on the server; every later page asks for the next slice of that same list. Never
 * fetched again by itself — not on focus, not by any tag edit — so nothing moves under the person
 * working through it; a new `visit` is a fresh list. See docs/CACHE_KEYS.md "Review › Faces".
 */
export const useFaceReview = (
    tab: FaceReviewTab,
    performer: string | null,
    media: ReviewMedia,
    visit: number
) =>
    useInfiniteQuery({
        queryKey: queryKeys.faceReview.list(tab, performer, media, visit),
        queryFn: ({ pageParam }) =>
            api<FaceReviewPage>(
                `/api/faces/review?tab=${tab}&page=${pageParam.page}` +
                    (pageParam.list ? `&list=${encodeURIComponent(pageParam.list)}` : "") +
                    (performer ? `&performer=${encodeURIComponent(performer)}` : "") +
                    (media === "all" ? "" : `&media=${media}`)
            ),
        initialPageParam: { page: 0, list: null } as { page: number; list: string | null },
        getNextPageParam: (last, pages) =>
            last.hasMore ? { page: pages.length, list: last.list } : undefined,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });

/**
 * Answer a Review › Faces row. Tagging — accepting, or naming who it is — is a tag edit like any
 * other and may coin a performer, so it moves everything a vocabulary change does, the review
 * itself and every performer's faces included. A refusal moves only the faces: the review, and
 * that performer's two sections.
 */
export const useDecideFaceReview = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (decision: FaceReviewDecision) =>
            api<FaceReviewResult>("/api/faces/review", {
                method: "POST",
                body: JSON.stringify(decision),
            }),
        onSuccess: (_, decision) => {
            // The list itself is not touched: the sheet settles the row in place.
            if (decision.verdict === "refuse") {
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.tags.faces(decision.tagId),
                });
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.tags.likely(decision.tagId),
                });
            } else {
                invalidateVocabulary(queryClient);
            }
        },
    });
};

/**
 * How alike a review row's faces are to who it asks about: asked for every row as soon as its page
 * arrives, so a row is drawn once, finished (§5f "A list that holds still"). Kept for the visit:
 * the faces do not change under a row.
 */
export const faceLikenessQuery = (groupId: string, tagId: string | null, faceIds: string[]) => {
    const ids = faceIds.join(",");

    return {
        queryKey: queryKeys.faceReview.likeness(groupId, tagId, ids),
        queryFn: () =>
            api<FaceLikeness>(
                `/api/faces/review/likeness?groupId=${encodeURIComponent(groupId)}&ids=${encodeURIComponent(ids)}` +
                    (tagId ? `&tagId=${encodeURIComponent(tagId)}` : "")
            ),
        enabled: faceIds.length > 0,
        staleTime: Infinity,
    };
};

/** A closer look at one face: asked for only while it is open. */
export const useFacePeek = (groupId: string, mediaId: string, enabled: boolean) =>
    useQuery({
        queryKey: queryKeys.tags.facePeek(groupId, mediaId),
        queryFn: () =>
            api<FacePeek>(
                `/api/faces/peek?groupId=${encodeURIComponent(groupId)}&mediaId=${encodeURIComponent(mediaId)}`
            ),
        enabled,
        staleTime: Infinity,
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
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.tags.likely(decision.tagId),
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
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.likely(tagId) });
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
            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.likely(tagId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.faceHistory.all() });
        },
    });
};
