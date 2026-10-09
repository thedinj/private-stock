"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ClipDetail, ClipTag, MediaDetail, MediaTag, TagScope } from "@private-stock/core";

import { api, ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * One facet's tags on one item, edited a chip at a time (§5b).
 *
 * The box used to submit the whole facet with `mode: "replace"`, built from the item as the
 * server last described it. That list is stale for the length of a round trip, so a second chip
 * added before the first save came back was sent without the first -- and replaced it away. On
 * a NAS under a scanning worker that round trip is seconds, which is long enough to type
 * another name. Three things change here, and each answers part of that:
 *
 * - **One add or remove per request.** Neither depends on what the client believes the rest of
 *   the facet is, so nothing can be erased by being left out of a list.
 * - **Queued, in order.** The mutations share a `scope`, which TanStack runs one after another,
 *   so a remove can never overtake the add it is undoing.
 * - **Shown at once.** The edit is drawn the moment it is made and folded into the item when the
 *   server answers, so the chip does not vanish for the round trip and reappear.
 *
 * And **a busy database is retried rather than reported**. A 503 means the worker held the write
 * lock past the web's budget (§20); nothing failed, and an add or a remove is safe to repeat.
 * That was the red "Could not save" which worked when tried again by hand.
 */

type EditOp = "add" | "remove";

interface PendingEdit {
    id: number;
    op: EditOp;
    name: string;
}

/** Contention and a dropped connection are worth another go; anything else is an answer. */
const isTransient = (error: unknown): boolean =>
    !(error instanceof ApiError) || error.status === 503;

const sameName = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

/** One chip as drawn: a saved tag, or a name whose add has not come back yet. */
export interface ItemTagChip {
    name: string;
    /** Absent until the server has the tag, which is what makes a chip a link. */
    tagId?: string;
    source?: MediaTag["source"];
    pending: boolean;
}

/** What a chip needs from a saved tag, on an item or on a clip. */
type SavedTag = Pick<MediaTag, "name" | "tagId"> & { source?: MediaTag["source"] };

/** The saved tags with the edits still in flight applied over them, in the order they were made. */
const applyEdits = (saved: SavedTag[], edits: PendingEdit[]): ItemTagChip[] =>
    edits.reduce<ItemTagChip[]>(
        (chips, edit) =>
            edit.op === "add"
                ? chips.some((chip) => sameName(chip.name, edit.name))
                    ? chips
                    : [...chips, { name: edit.name.trim(), pending: true }]
                : chips.filter((chip) => !sameName(chip.name, edit.name)),
        saved.map((tag) => ({
            name: tag.name,
            tagId: tag.tagId,
            source: tag.source,
            pending: false,
        }))
    );

interface QueuedFacetOptions<T extends SavedTag> {
    /** One queue per box, so a remove can never overtake the add it is undoing. */
    queue: string;
    url: string;
    kind: string;
    scope: TagScope;
    saved: T[];
    /** Writes the stored list into whatever cache holds it, and invalidates what it moves. */
    onSaved: (tags: T[], op: EditOp) => void;
}

/**
 * The queued, one-chip-at-a-time edit described above, for whatever the tags are on.
 *
 * An item and a clip share it (§14d "Tagging clips"): the race it closes does not care what the
 * tags are attached to.
 */
const useQueuedFacetTags = <T extends SavedTag>({
    queue,
    url,
    kind,
    scope,
    saved,
    onSaved,
}: QueuedFacetOptions<T>) => {
    const nextId = useRef(0);
    const [pending, setPending] = useState<PendingEdit[]>([]);
    const [error, setError] = useState<string | null>(null);

    const settle = (edit: PendingEdit) =>
        setPending((current) => current.filter((entry) => entry.id !== edit.id));

    const mutation = useMutation({
        scope: { id: queue },
        mutationFn: (edit: PendingEdit) =>
            api<{ tags: T[] }>(url, {
                method: "PUT",
                body: JSON.stringify({ kind, names: [edit.name], scope, mode: edit.op }),
            }),
        retry: (failureCount, cause) => failureCount < 3 && isTransient(cause),
        retryDelay: (attempt) => 1_000 * (attempt + 1),
        onSuccess: ({ tags }, edit) => {
            onSaved(tags, edit.op);
            settle(edit);
        },
        onError: (cause, edit) => {
            settle(edit);
            setError(
                `Could not ${edit.op === "add" ? "add" : "remove"} "${edit.name}": ${
                    cause instanceof ApiError ? cause.displayMessage : "the server did not answer"
                }`
            );
        },
    });

    const chips = useMemo(() => applyEdits(saved, pending), [saved, pending]);

    const send = useCallback(
        (op: EditOp, name: string) => {
            if (!name.trim()) return;

            const edit = { id: nextId.current++, op, name: name.trim() };

            setError(null);
            setPending((current) => [...current, edit]);
            mutation.mutate(edit);
        },
        [mutation]
    );

    const add = useCallback(
        (name: string) => {
            // Already on it, or already on its way: nothing to send.
            if (!chips.some((chip) => sameName(chip.name, name))) send("add", name);
        },
        [chips, send]
    );

    const remove = useCallback((name: string) => send("remove", name), [send]);

    return { chips, add, remove, error };
};

/**
 * The suggestion lists, after a chip is saved.
 *
 * Marked stale, not refetched. The box being typed in holds one of these, and refetching it
 * under the dropdown after every chip replaced its options while somebody was choosing from
 * them. A name coined here is already on the item; the lists pick it up the next time a box is
 * opened or the window regains focus.
 *
 * Except after a removal, which can retire the tag (`pruneUnused`) and would leave it offered as
 * a suggestion. A removal is a click on ×, not typing, so there is no open dropdown for the
 * refetch to disturb.
 */
const refreshSuggestions = (
    queryClient: ReturnType<typeof useQueryClient>,
    kind: string,
    scope: TagScope,
    op: EditOp
): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags.all(), refetchType: "none" });

    if (op === "remove") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tags.byKind(kind, scope) });
    }
};

export const useItemFacetTags = (
    mediaId: string,
    kind: string,
    scope: TagScope,
    saved: MediaTag[]
) => {
    const queryClient = useQueryClient();

    return useQueuedFacetTags({
        queue: `item-tags:${mediaId}:${kind}:${scope}`,
        url: `/api/media/${mediaId}/tags`,
        kind,
        scope,
        saved,
        onSaved: (tags, op) => {
            /**
             * The response is the item's whole tag list as stored, written in rather than
             * refetched. A refetch already in flight began before this write and would land
             * after it with the old list, so it is cancelled first.
             */
            void queryClient.cancelQueries({ queryKey: queryKeys.media.detail(mediaId) });
            queryClient.setQueryData<MediaDetail>(queryKeys.media.detail(mediaId), (current) =>
                current ? { ...current, tags } : current
            );

            // Every filter's counts move. See docs/CACHE_KEYS.md "Tag edits on one item".
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.facets() });
            refreshSuggestions(queryClient, kind, scope, op);
        },
    });
};

/**
 * One facet's tags on one clip (§14d "Tagging clips").
 *
 * The clip detail takes the stored list directly; the browser's pages, its tag chips and the
 * item page's strip (which rides `media.detail`) are invalidated. See docs/CACHE_KEYS.md
 * "Tag edits on one clip".
 */
export const useClipFacetTags = (
    clipId: string,
    mediaId: string,
    kind: string,
    scope: TagScope,
    saved: ClipTag[]
) => {
    const queryClient = useQueryClient();

    return useQueuedFacetTags({
        queue: `clip-tags:${clipId}:${kind}:${scope}`,
        url: `/api/clips/${clipId}/tags`,
        kind,
        scope,
        saved,
        onSaved: (tags, op) => {
            void queryClient.cancelQueries({ queryKey: queryKeys.clips.detail(clipId) });
            queryClient.setQueryData<ClipDetail>(queryKeys.clips.detail(clipId), (current) =>
                current ? { ...current, tags } : current
            );
            void queryClient.invalidateQueries({ queryKey: queryKeys.clips.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.detail(mediaId) });
            refreshSuggestions(queryClient, kind, scope, op);
        },
    });
};
