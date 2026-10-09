"use client";

import { useState } from "react";
import {
    Alert,
    Anchor,
    Badge,
    Box,
    Button,
    Checkbox,
    Group,
    Loader,
    Modal,
    ScrollArea,
    Stack,
    Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    MediaCopiesResponse,
    MediaCopy,
    MediaDetail,
    TrashMediaResponse,
} from "@private-stock/core";

import { api, ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateListable } from "@/lib/api/trash";
import { formatBytes, formatDuration } from "@/lib/dupeTriage";
import { planTrash, tickedByDefault } from "@/lib/trashCopies";

/**
 * Moving one item to the recycle bin (§10), and whichever of its copies go with it (§10d).
 *
 * **Only the confirmation, not the button.** The viewer can reach it three ways — the trash icon
 * beside the title, `Delete` / `Backspace` on the keyboard, and the button at the foot of the
 * Details drawer — and all three open this one dialog, owned by the page, exactly as the stars and
 * `h` go through one `setOpinion`. Whoever renders it has already decided the viewer may delete
 * (the `delete` scope) and the root allows it (`deletable`); the server has the last word either
 * way, and its error says clearly when a read-only root refuses.
 *
 * **This is the moment a duplicate is actually eliminated**, so it is where the comparison has
 * to be repeated (§10c). And it is where somebody who does not want an item says so, which
 * usually means they want none of its copies either (§10d): the copies are listed, the identical
 * ones ticked, the rest left for a person to look at — a near duplicate can be the film a clip
 * was cut from.
 *
 * **Delete, then Enter.** The button the dialog recommends has the focus when it opens, so
 * weeding from the keyboard is two keystrokes and Escape backs out. When the best copy would go
 * while a worse one stays, the recommendation — and so the focus — is Cancel: a reflexive Enter
 * must not be what removes the copy worth keeping.
 */

interface TrashConfirmProps {
    opened: boolean;
    onClose: () => void;
    mediaId: string;
    title: string;
    /** Where this item stands among its copies, or null when it has none (§10c). */
    duplicate: MediaDetail["duplicate"];
    /**
     * Where to go once the item is in the bin — the page it was on has nothing left to show.
     *
     * The viewer's call rather than this dialog's: it knows the set the item was opened from,
     * so it can step on to the next one, or return to wherever "back" leads. Handed everything
     * that went, because a copy that went with it may well be the next item in the set.
     */
    onDeleted: (trashed: string[]) => void;
}

const resolution = (copy: MediaCopy): string | null =>
    copy.width && copy.height ? `${copy.width}×${copy.height}` : null;

/** One copy: what it is, where it is, and anything worth a look before it goes. */
const CopyRow: React.FC<{
    copy: MediaCopy;
    checked: boolean;
    onToggle: () => void;
}> = ({ copy, checked, onToggle }) => {
    const numbers = [
        resolution(copy),
        copy.kind === "video" ? formatDuration(copy.durationMs) : null,
        formatBytes(copy.sizeBytes),
    ]
        .filter(Boolean)
        .join(" · ");

    return (
        <Group gap="sm" wrap="nowrap" align="flex-start">
            {/* A read-only copy stays whatever is ticked (§18.1); shown, so the dialog does
                not claim the group is gone when one is left behind. */}
            <Checkbox
                mt={4}
                color="oxblood"
                checked={checked && copy.deletable}
                disabled={!copy.deletable}
                onChange={onToggle}
                aria-label={`Also trash the copy at ${copy.relPath}`}
            />

            {/* Opens in a new tab: looking properly at a copy must not close the question. */}
            <Anchor
                href={`/media/${copy.id}`}
                target="_blank"
                rel="noopener"
                style={{ flexShrink: 0 }}
                aria-label={`Open the copy at ${copy.relPath} in a new tab`}
            >
                {copy.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={copy.coverUrl}
                        alt=""
                        width={72}
                        height={44}
                        loading="lazy"
                        decoding="async"
                        style={{ objectFit: "cover", borderRadius: 4, display: "block" }}
                    />
                ) : (
                    <Box w={72} h={44} bg="dark.6" style={{ borderRadius: 4 }} />
                )}
            </Anchor>

            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="wrap">
                    <Text size="sm">{numbers}</Text>
                    {copy.identical && (
                        <Badge size="xs" variant="light" color="gray">
                            Identical
                        </Badge>
                    )}
                    {copy.best && (
                        <Badge size="xs" variant="light" color="brass">
                            Best copy
                        </Badge>
                    )}
                    {!copy.deletable && (
                        <Badge size="xs" variant="light" color="gray">
                            Read-only library
                        </Badge>
                    )}
                </Group>
                <Text size="xs" c="dimmed" truncate="start" title={copy.relPath}>
                    {copy.rootLabel} · {copy.relPath}
                </Text>
                {copy.caution && (
                    <Text size="xs" c="brass.4">
                        {copy.caution}
                    </Text>
                )}
                {copy.clipCount > 0 && (
                    <Text size="xs" c="brass.4">
                        {copy.clipCount} clip{copy.clipCount === 1 ? "" : "s"} cut from it — they do
                        not move to another copy.
                    </Text>
                )}
            </Stack>
        </Group>
    );
};

export const TrashConfirm: React.FC<TrashConfirmProps> = ({
    opened,
    onClose,
    mediaId,
    title,
    duplicate,
    onDeleted,
}) => {
    const queryClient = useQueryClient();
    const narrow = useMediaQuery("(max-width: 48em)") ?? false;

    /**
     * Fetched as soon as the item is known to have copies, not when the dialog opens.
     *
     * The identical ones start ticked, so what Delete then Enter removes depends on this list.
     * Loaded on open, a quick Enter would trash the item alone and a slow one the item and its
     * copies — the same two keys, two outcomes. The item page renders this dialog only for
     * somebody who may delete, and only items with copies ask.
     */
    const copiesQuery = useQuery({
        queryKey: queryKeys.media.copies(mediaId),
        queryFn: () => api<MediaCopiesResponse>(`/api/media/${mediaId}/copies`),
        enabled: duplicate !== null,
        staleTime: 60_000,
    });
    const copies = duplicate ? (copiesQuery.data?.copies ?? []) : [];

    /** What the viewer ticked, or null while they have left the defaults alone. */
    const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
    const ticked = picked ?? new Set(copies.filter(tickedByDefault).map((copy) => copy.id));

    const toggle = (id: string) => {
        const next = new Set(ticked);

        if (next.has(id)) next.delete(id);
        else next.add(id);

        setPicked(next);
    };

    const deletable = copies.filter((copy) => copy.deletable);
    const allTicked = deletable.length > 0 && deletable.every((copy) => ticked.has(copy.id));

    const plan = duplicate ? planTrash(duplicate, copies, ticked) : null;
    const going = plan?.alsoTrash ?? [];
    const bestGoing = plan?.bestGoing ?? false;

    const trash = useMutation({
        mutationFn: () =>
            api<TrashMediaResponse>(`/api/media/${mediaId}/trash`, {
                method: "DELETE",
                body: JSON.stringify({ alsoTrash: going.map((copy) => copy.id) }),
            }),
        onSuccess: (result) => {
            invalidateListable(queryClient);

            // Every trash of a group member changes the group the review screen shows.
            if (duplicate) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() });
            }

            // Anything refused stays on screen, and the viewer moves on when they have read
            // it -- see `leave`.
            if (result.failed.length === 0) {
                onClose();
                onDeleted(result.trashed);
            }
        },
    });

    const outcome = trash.data;
    const itemWent = outcome?.trashed.includes(mediaId) ?? false;

    // A refusal from the last attempt is not news the next time the dialog opens, and neither
    // are the ticks somebody changed and then backed out of.
    const close = () => {
        trash.reset();
        setPicked(null);
        onClose();
    };

    /** After a partial success: the item went, some copy did not, and that has been read. */
    const leave = () => {
        const trashed = outcome?.trashed ?? [];

        trash.reset();
        onClose();
        onDeleted(trashed);
    };

    const count = 1 + going.length;

    /**
     * Whether a byte-identical copy stays, so this item is deleted outright (§10e).
     *
     * An identical copy bypasses the bin: nothing is kept to restore, because the content is
     * still in the copy that stays. Said up front, because it changes what "trash" means here.
     * Only the copies this viewer can see are known; the server has the last word.
     */
    const goingIds = new Set(going.map((copy) => copy.id));
    const identicalStays = copies.some((copy) => copy.identical && !goingIds.has(copy.id));
    const identicalGoing = going.some((copy) => copy.identical);
    const pathOf = (id: string) => copies.find((copy) => copy.id === id)?.relPath ?? "This item";

    return (
        <Modal
            opened={opened}
            // Once the item has gone there is nothing to cancel back to.
            onClose={itemWent ? leave : close}
            title={count > 1 ? `Move ${count} items to trash?` : "Move to trash?"}
            centered
            size={duplicate ? "lg" : "md"}
            // Above a fullscreen player, which is laid over the page at the modal layer
            // (`usePlayerFullscreen`) — Delete is pressed from fullscreen as often as not.
            zIndex="calc(var(--mantine-z-index-modal) + 2)"
        >
            <Stack gap="md">
                {/*
                 * Says where it goes and that it can come back. A confirmation that only
                 * says "are you sure" makes a recoverable action feel like a permanent
                 * one, and people then avoid the feature that exists to help them.
                 */}
                <Text size="sm">
                    {identicalStays
                        ? `${title} will be deleted outright rather than kept in the trash: an identical copy of it stays in the library.`
                        : `${title} will be removed from the library and kept in the trash, where an administrator can restore it until its retention window closes.`}
                </Text>

                {/* The ticked identical copies go outright too, all but the last of the same
                    bytes -- which keeps the content in the trash when every copy goes. */}
                {identicalGoing && !identicalStays && (
                    <Text size="sm" c="dimmed">
                        Identical copies are deleted outright, not kept in the trash. One copy of
                        the same bytes goes to the trash, so the content can still be restored.
                    </Text>
                )}
                {identicalGoing && identicalStays && (
                    <Text size="sm" c="dimmed">
                        The ticked identical copies are deleted outright too.
                    </Text>
                )}

                {/* The copies, when there are any to see (§10d). */}
                {duplicate && copiesQuery.isPending && (
                    <Group gap="xs">
                        <Loader size="xs" color="brass" />
                        <Text size="sm" c="dimmed">
                            Looking at its copies…
                        </Text>
                    </Group>
                )}

                {duplicate && copiesQuery.isError && (
                    <Text size="sm" c="dimmed">
                        Its copies could not be listed; only this item will go.
                    </Text>
                )}

                {copies.length > 0 && (
                    <Stack gap="xs">
                        <Group justify="space-between" wrap="nowrap">
                            <Text size="sm" fw={600}>
                                Also trash its other {copies.length === 1 ? "copy" : "copies"}?
                            </Text>
                            {deletable.length > 1 && (
                                <Button
                                    size="compact-sm"
                                    variant="subtle"
                                    color="gray"
                                    onClick={() =>
                                        setPicked(
                                            allTicked
                                                ? new Set()
                                                : new Set(deletable.map((copy) => copy.id))
                                        )
                                    }
                                >
                                    {allTicked ? "Untick all" : "Tick all"}
                                </Button>
                            )}
                        </Group>

                        {/* Bounded: chaining can make a group long (§10b), and the buttons
                            must stay on screen however many copies there are. */}
                        <ScrollArea.Autosize mah={narrow ? 240 : 320} type="auto">
                            <Stack gap="sm">
                                {copies.map((copy) => (
                                    <CopyRow
                                        key={copy.id}
                                        copy={copy}
                                        checked={ticked.has(copy.id)}
                                        onToggle={() => toggle(copy.id)}
                                    />
                                ))}
                            </Stack>
                        </ScrollArea.Autosize>
                    </Stack>
                )}

                {/*
                 * Both directions, deliberately. The warning when the best copy would go is
                 * what prevents the mistake; the reassurance otherwise is what stops that
                 * warning reading as a general discouragement from tidying up, which across a
                 * library this size is the more expensive failure.
                 *
                 * When no copy stays at all, neither applies — there is no copy to keep — and
                 * what is worth saying is where the ratings went.
                 */}
                {duplicate && plan?.noneLeft && (
                    <Alert variant="light" color="brass" title="No copy stays">
                        Every copy goes, and what anybody recorded about it is gathered on the best
                        copy — the one the trash keeps, so restoring it brings everything back.
                    </Alert>
                )}

                {duplicate && !plan?.noneLeft && (
                    <Alert
                        variant="light"
                        color={bestGoing ? "oxblood" : "brass"}
                        title={
                            duplicate.best
                                ? "This is the copy to keep"
                                : bestGoing
                                  ? "The best copy is ticked"
                                  : "It has copies"
                        }
                    >
                        {!duplicate.best && bestGoing
                            ? "A worse copy would stay in its place. Untick the best copy to keep it."
                            : duplicate.advice}
                    </Alert>
                )}

                {duplicate && !plan?.noneLeft && (
                    <Text size="xs" c="dimmed">
                        Ratings, tags, notes and playlist places move to the copy that stays.
                    </Text>
                )}

                {/*
                 * What does **not** move (§10c, §14d).
                 *
                 * Clips are deliberately not carried across: a near duplicate is a different
                 * encode with a different timeline, so a timecode moved onto it would point
                 * at the wrong frames — a silent wrong answer, which is worse than a visible
                 * loss. But a loss nobody was told about is indistinguishable from a bug, so
                 * it is named here, at the deletion, where §10c says the warning belongs.
                 *
                 * "When the trash is purged" rather than "now": `Media` survives the trash,
                 * so restoring brings every span back with it.
                 */}
                {duplicate && duplicate.clipsAtRisk.total > 0 && (
                    <Alert variant="light" color="brass" title="Clips on this copy">
                        <Text size="sm">
                            {duplicate.clipsAtRisk.total} clip
                            {duplicate.clipsAtRisk.total === 1 ? " is" : "s are"} marked on this
                            copy
                            {duplicate.clipsAtRisk.mine > 0 &&
                                duplicate.clipsAtRisk.mine !== duplicate.clipsAtRisk.total &&
                                `, ${duplicate.clipsAtRisk.mine} of them yours`}
                            . They do not move to the copy that stays — a different encode has a
                            different timeline — and purging the trash removes them.
                            {duplicate.clipsAtRisk.reels.length > 0 &&
                                ` That would shorten ${duplicate.clipsAtRisk.reels
                                    .map((reel) => reel.name)
                                    .join(", ")}.`}
                        </Text>
                    </Alert>
                )}

                {plan && plan.clipsOnCopies > 0 && (
                    <Text size="xs" c="brass.4">
                        The ticked copies hold {plan.clipsOnCopies} more clip
                        {plan.clipsOnCopies === 1 ? "" : "s"}, which purging the trash removes.
                    </Text>
                )}

                {trash.error && (
                    <Text size="sm" c="red">
                        {trash.error instanceof ApiError
                            ? trash.error.message
                            : "Could not delete this item"}
                    </Text>
                )}

                {/* Partly done: what went, and each thing that did not with its reason. */}
                {outcome && outcome.failed.length > 0 && (
                    <Alert
                        variant="light"
                        color="oxblood"
                        title={
                            itemWent
                                ? `${outcome.trashed.length} moved to the trash; not everything could go`
                                : "This item could not be moved to the trash"
                        }
                    >
                        <Stack gap={4}>
                            {outcome.failed.map((failure) => (
                                <Text key={failure.mediaId} size="sm">
                                    {failure.mediaId === mediaId
                                        ? "This item"
                                        : pathOf(failure.mediaId)}
                                    : {failure.reason}
                                </Text>
                            ))}
                        </Stack>
                    </Alert>
                )}

                {/* Side by side and full width on a phone, where they are what a thumb reaches
                    for; each stands 44px (CLAUDE.md). */}
                {outcome && outcome.failed.length > 0 ? (
                    <Group justify="flex-end" grow={narrow}>
                        <Button
                            variant="default"
                            onClick={itemWent ? leave : close}
                            data-autofocus
                            style={{ minHeight: 44 }}
                        >
                            {itemWent ? "Continue" : "Close"}
                        </Button>
                    </Group>
                ) : (
                    <Group justify="flex-end" grow={narrow}>
                        {/* Given weight when the destructive button loses it, so the pair
                            reads as a recommendation rather than as two equal options. */}
                        <Button
                            variant={bestGoing ? "default" : "subtle"}
                            onClick={close}
                            data-autofocus={bestGoing || undefined}
                            style={{ minHeight: 44 }}
                        >
                            Cancel
                        </Button>
                        <Button
                            // Deleting the best copy stays possible and stops being the
                            // default: the reviewer may have a reason the numbers cannot see,
                            // and a disabled button would leave them with no way to act on it
                            // (§14). The emphasis — and the focus — move to Cancel instead.
                            color="oxblood"
                            variant={bestGoing ? "outline" : "filled"}
                            loading={trash.isPending}
                            onClick={() => trash.mutate()}
                            data-autofocus={!bestGoing || undefined}
                            style={{ minHeight: 44 }}
                        >
                            {bestGoing
                                ? "Delete the best copy"
                                : count > 1
                                  ? `Move ${count} to trash`
                                  : "Move to trash"}
                        </Button>
                    </Group>
                )}
            </Stack>
        </Modal>
    );
};
