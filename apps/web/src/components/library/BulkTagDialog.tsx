"use client";

import { useRef, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Group,
    Loader,
    Modal,
    Stack,
    Text,
    type ComboboxProps,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    allowsPrivate,
    clipTagKinds,
    tagKinds,
    type BulkActionResult,
    type BulkTagPreviewResult,
    type BulkTagResult,
    type SavedQuery,
    type TagBatch,
    type TagScope,
} from "@private-stock/core";

import { api, ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateVocabulary } from "@/lib/api/tags";
import { destinationsFor, type TagDestination } from "@/lib/tagDestinations";
import { useTagNames } from "@/lib/useTagNames";
import { DestinationControl } from "@/components/tags/DestinationControl";
import { TagNameInput } from "@/components/tags/TagNameInput";
import { describeBulkResult } from "./describeBulkResult";

/**
 * Tagging many items at once — the ticked ones, or everything a filter matches (§5d, §14b).
 *
 * **One dialogue for both.** They were two, laid out identically and already drifting: the
 * same scope switch, the same facet dropdown, the same box, maintained twice. What differs is
 * the set and what the server can promise about it, and that is all `target` carries.
 *
 * For a filter, three things make an action that can be wrong about thousands of items safe to
 * attempt:
 *
 * - **A preview before committing.** The count is shown before the action, not after — and the
 *   apply sends it back so the server can refuse if the library moved underneath it. Somebody
 *   agreed to a number, and "added this week" means something different ten minutes later.
 * - **A withdrawable batch.** The apply writes a `TagBatch`, and withdrawing it deletes exactly
 *   the rows it created. A tag somebody typed by hand on the same item is skipped by the unique
 *   index, never joins the batch, and survives the undo.
 * - **A refusal above the limit**, rather than a silent truncation to an arbitrary ten thousand.
 *
 * A selection needs none of them: the set is on screen and was ticked by hand.
 */

export type BulkTagTarget =
    | { type: "selection"; mediaIds: string[] }
    /**
     * The filter as the grid resolved it, and the saved filter it was opened from, so a shared
     * one is resolved against the same person's ratings here as it was for the grid (§6).
     */
    | { type: "filter"; query: SavedQuery; filterId: string | null }
    /**
     * Ticked clips on /clips (§14d "Tagging clips"). Like a selection, no preview; unlike one, it
     * writes a batch, so the page can offer Undo straight away.
     */
    | { type: "clips"; clipIds: string[] };

/**
 * A tag to open holding, already in its facet and audience (§5d "Find untagged").
 *
 * The library offers the tag a "Find untagged" came from, so applying it to what was found is
 * a confirmation rather than a spelling test. Only a starting point: the box can still be
 * changed before applying. Read once, when the dialogue mounts; the caller keys it on the tag.
 */
export interface SuggestedTag {
    name: string;
    kind: string;
    scope: TagScope;
}

interface BulkTagDialogProps {
    opened: boolean;
    onClose: () => void;
    target: BulkTagTarget;
    /** `batch` is set when the apply wrote one, which is what an Undo needs. */
    onApplied: (message: string, batch?: TagBatch) => void;
    suggested?: SuggestedTag | null;
}

/**
 * Where the names can go: a facet, and for keywords an audience (`lib/tagDestinations.ts`).
 * Every facet for items; performer and keyword for clips (§14d "Tagging clips").
 */
const ITEM_DESTINATIONS = destinationsFor(tagKinds);
const CLIP_DESTINATIONS = destinationsFor(clipTagKinds);

/**
 * Suggestions open upward, and only as tall as the room above the box.
 *
 * Below, they covered the Apply button for as long as the box had focus — which is the whole
 * time anybody is typing, so reaching Apply meant dismissing the list first. Flip is off
 * because flipping back down is exactly the placement being avoided; the height comes from the
 * space measured above instead, so a short screen gets a shorter list rather than one that
 * runs off the top.
 */
const SUGGESTIONS_ABOVE: ComboboxProps = {
    position: "top",
    middlewares: {
        flip: false,
        shift: true,
        size: {
            padding: 8,
            apply: ({ availableHeight, elements }) => {
                elements.floating.style.setProperty(
                    "--bulk-tag-room",
                    `${Math.max(availableHeight, 96)}px`
                );
            },
        },
    },
};

export const BulkTagDialog: React.FC<BulkTagDialogProps> = ({
    opened,
    onClose,
    target,
    onApplied,
    suggested,
}) => {
    const queryClient = useQueryClient();
    const clips = target.type === "clips";
    const DESTINATIONS = clips ? CLIP_DESTINATIONS : ITEM_DESTINATIONS;
    const noun = clips ? "clip" : "item";
    /**
     * The first facet in `tagKinds` order — Performer, the one most bulk edits want.
     *
     * The audience is never remembered: this reaches every item at once, so it has to be a
     * decision made in front of the confirmation rather than one carried in from last time.
     */
    const [destination, setDestination] = useState<TagDestination>(
        () =>
            DESTINATIONS.find(
                (option) => option.kind === suggested?.kind && option.scope === suggested.scope
            ) ?? DESTINATIONS[0]
    );
    const { kind, scope } = destination;
    const tags = useTagNames(suggested ? [suggested.name] : []);
    /** Holds the names box, so picking a facet can put the caret back in it. */
    const namesBox = useRef<HTMLDivElement>(null);

    const filter = target.type === "filter" ? target : null;

    const preview = useQuery({
        // Keyed by the filter, so reopening the dialogue on the same view does not re-count.
        queryKey: queryKeys.media.count(
            `bulk:${JSON.stringify({ query: filter?.query, filterId: filter?.filterId })}`
        ),
        queryFn: () =>
            api<BulkTagPreviewResult>("/api/tags/bulk", {
                method: "POST",
                body: JSON.stringify({
                    query: filter?.query,
                    filterId: filter?.filterId,
                    excludeIds: [],
                }),
            }),
        enabled: opened && filter !== null,
    });

    const affected =
        target.type === "selection"
            ? target.mediaIds.length
            : target.type === "clips"
              ? target.clipIds.length
              : (preview.data?.affected ?? 0);
    const overLimit = filter !== null && (preview.data?.overLimit ?? false);

    const apply = useMutation({
        mutationFn: async (names: string[]): Promise<{ message: string; batch?: TagBatch }> => {
            if (target.type === "clips") {
                const result = await api<BulkTagResult>("/api/clips/bulk/tags", {
                    method: "POST",
                    body: JSON.stringify({ clipIds: target.clipIds, kind, names, scope }),
                });
                const count = result.batch.clipCount ?? 0;

                return {
                    message: `Tagged ${count.toLocaleString()} clip${count === 1 ? "" : "s"}`,
                    batch: result.batch,
                };
            }

            if (target.type === "selection") {
                const result = await api<BulkActionResult>("/api/media/bulk", {
                    method: "POST",
                    body: JSON.stringify({
                        action: "tag",
                        mediaIds: target.mediaIds,
                        kind,
                        names,
                        scope,
                    }),
                });

                return { message: describeBulkResult(result) };
            }

            const result = await api<BulkTagResult>("/api/tags/bulk", {
                method: "PUT",
                body: JSON.stringify({
                    query: target.query,
                    filterId: target.filterId,
                    excludeIds: [],
                    kind,
                    names,
                    scope,
                    // Sent back so the server can refuse if the library moved since the
                    // preview. Refusing is the feature, not an inconvenience.
                    expectedCount: affected,
                }),
            });

            return {
                message: `Tagged ${result.batch.mediaCount.toLocaleString()} items`,
                batch: result.batch,
            };
        },
        onSuccess: ({ message, batch }) => {
            // Coins names and moves every facet count (`docs/CACHE_KEYS.md` §2).
            invalidateVocabulary(queryClient);
            onApplied(message, batch);
            tags.reset();
            onClose();
        },
    });

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={
                filter === null
                    ? `Tag ${affected} ${noun}${affected === 1 ? "" : "s"}`
                    : "Tag everything matching"
            }
            centered
        >
            <Stack gap="sm">
                {filter === null ? null : preview.isLoading ? (
                    <Group gap="xs">
                        <Loader size="xs" color="brass" />
                        <Text size="sm" c="dimmed">
                            Counting what this matches…
                        </Text>
                    </Group>
                ) : overLimit ? (
                    /* Refused rather than truncated: acting on an arbitrary ten thousand of a
                       larger set is the accident this whole flow exists to prevent. */
                    <Alert color="oxblood" variant="light" title="Too many items">
                        This filter matches {preview.data?.matched.toLocaleString()} items, past the
                        limit of {preview.data?.limit.toLocaleString()}. Narrow it first.
                    </Alert>
                ) : (
                    <Text size="sm">
                        <strong>{affected.toLocaleString()}</strong> item
                        {affected === 1 ? "" : "s"} match the current filter.
                    </Text>
                )}

                {/* First, above the names, because it decides what the next thing typed is and
                    who it is for. Each segment says its audience under its facet, so the
                    choice of who sees it is never a separate control somebody can miss. */}
                {/* Picking a facet is the step before typing, so it hands focus straight to the
                    box -- otherwise every switch costs a second tap to start typing. After the
                    frame, so the segment's own click has finished taking focus first. */}
                <DestinationControl
                    options={DESTINATIONS}
                    value={destination}
                    onChange={(next) => {
                        setDestination(next);
                        requestAnimationFrame(() =>
                            namesBox.current?.querySelector("input")?.focus()
                        );
                    }}
                />

                {/* A clip is seen by its owner alone, so "shared" says whose word it is, not who
                    will see the clip (§14d "Tagging clips"). */}
                {clips && allowsPrivate(kind) && (
                    <Text size="xs" c="dimmed">
                        Clip tags are only visible to you. Shared means the library&rsquo;s word;
                        private means your own.
                    </Text>
                )}

                <Box ref={namesBox}>
                    <TagNameInput
                        kind={kind}
                        scope={scope}
                        label="Names"
                        placeholder="Type a name and press Enter"
                        {...tags.inputProps}
                        comboboxProps={SUGGESTIONS_ABOVE}
                        maxDropdownHeight="calc(min(220px, var(--bulk-tag-room, 220px)))"
                        data-autofocus
                    />
                </Box>

                {apply.error && (
                    <Alert color="oxblood" variant="light">
                        {apply.error instanceof ApiError
                            ? apply.error.message
                            : "Could not apply the tags"}
                    </Alert>
                )}

                {/* The filter-wide apply and a clip apply write a batch; a selection's tags come
                    off with Untag, from the same bar. */}
                {target.type !== "selection" && (
                    <Text size="xs" c="dimmed">
                        This can be withdrawn afterwards from Tags › Manage. Withdrawing removes
                        only what this apply wrote.
                    </Text>
                )}

                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    {/* For keywords the button spells out the audience, like every other bulk
                        write: "Apply to 412 items" does not say who will see them (§6). A
                        performer or a source has only one audience, so there is nothing to
                        spell out. */}
                    <Button
                        color="brass"
                        loading={apply.isPending}
                        disabled={!tags.ready || affected === 0 || overLimit}
                        onClick={() => apply.mutate(tags.collect())}
                    >
                        Apply to {affected.toLocaleString()} {noun}
                        {affected === 1 ? "" : "s"}
                        {/* On clips nobody else sees them either way, so "for everyone" would be
                            untrue; the note above says what the choice means instead. */}
                        {allowsPrivate(kind) &&
                            !clips &&
                            (scope === "public" ? " for everyone" : " privately")}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};
