"use client";

import { useState } from "react";
import {
    Alert,
    ActionIcon,
    Button,
    Group,
    Menu,
    Modal,
    Paper,
    Rating,
    Stack,
    Switch,
    Text,
    TextInput,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { type BulkActionInput, type BulkActionResult } from "@private-stock/core";

import { api, ApiError } from "@/lib/api/client";
import { useAddPlaylistItems, useCreatePlaylist, usePlaylists } from "@/lib/api/playlists";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateVocabulary, useRefuseMentions } from "@/lib/api/tags";
import { invalidateListable } from "@/lib/api/trash";
import { BulkTagDialog, type SuggestedTag } from "./BulkTagDialog";
import { describeBulkResult } from "./describeBulkResult";
import { UntagDialog } from "./UntagDialog";

import classes from "./SelectionBar.module.scss";
import { CloseGlyph, TrashGlyph } from "@/components/media/Glyph";

/**
 * What you can do to the items you have ticked (§14b).
 *
 * Four verbs: tag and untag, rate and favourite, add to a playlist, move to the bin. They
 * are the four because they are the ones that are tedious one at a time — everything else
 * about an item is either a single decision or something the pipeline does for you.
 *
 * **Fixed to the bottom of the viewport rather than sitting above the grid.** A selection is
 * made by scrolling and ticking, so an action bar that scrolls away is one you have to go
 * back for; and pushing the grid down when it appears would move the tiles out from under
 * the pointer that is selecting them.
 */

interface SelectionBarProps {
    /** The ids currently ticked, in the order the grid shows them. */
    selected: string[];
    onClear: () => void;
    /** Whether this account may move files to the bin at all (§18.1). */
    canDelete: boolean;
    /**
     * Told what happened, so the grid can drop the selection and still say so.
     *
     * The outcome is reported *upward* rather than rendered here, because clearing the
     * selection unmounts this bar — a message shown inside it would be destroyed by the
     * same event that produces it, and "11 deleted, 3 on a read-only library" is exactly
     * the sentence nobody would ever see.
     */
    onApplied: (outcome: string) => void;
    /** A tag to offer in one click, from a "Find untagged" (§5d); see `BulkTagDialog`. */
    suggestedTag?: SuggestedTag | null;
    /**
     * The tag a "Find untagged" came from, where this viewer may say the items found are not
     * them: they stop being offered for it (§5d).
     */
    refusable?: { tagId: string; name: string } | null;
}

/**
 * One action, minus the ids the bar supplies itself.
 *
 * Distributive on purpose. A plain `Omit<BulkActionInput, "mediaIds">` collapses the
 * discriminated union into one object type whose only common key is `action`, so every
 * variant's own fields become unknown properties — the error looks like a typo and is
 * actually TypeScript refusing to distribute over the union.
 */
type BulkAction = BulkActionInput extends infer Variant
    ? Variant extends { mediaIds: string[] }
        ? Omit<Variant, "mediaIds">
        : never
    : never;

export const SelectionBar: React.FC<SelectionBarProps> = ({
    selected,
    onClear,
    canDelete,
    onApplied,
    suggestedTag,
    refusable,
}) => {
    const queryClient = useQueryClient();
    const refuse = useRefuseMentions(refusable?.tagId ?? null);

    /**
     * The two tag dialogues, opened separately.
     *
     * They used to be one modal in two modes, which is what made removing a tag a spelling
     * test: the remove mode inherited a box for typing names, so taking "beach" off forty
     * items meant remembering how "beach" was spelt when somebody else coined it. They share
     * nothing now but the selection.
     */
    const [tagging, setTagging] = useState(false);
    const [untagging, setUntagging] = useState(false);
    const [confirmTrash, setConfirmTrash] = useState(false);

    const playlists = usePlaylists();

    const act = useMutation({
        mutationFn: (input: BulkAction) =>
            api<BulkActionResult>("/api/media/bulk", {
                method: "POST",
                body: JSON.stringify({ ...input, mediaIds: selected }),
            }),
        onSuccess: (result, input) => {
            /**
             * A tag write moves more than the grid.
             *
             * Every page is potentially wrong whatever the verb -- a trashed item has left it,
             * a rating may have changed the sort -- so the list is invalidated whole rather
             * than patched. Untagging can retire the last use of a name, so it takes the
             * vocabulary cascade as well, as tagging does in `BulkTagDialog` (`docs/CACHE_KEYS.md` §2). Rating and favouriting do not: it
             * would discard facet caches nothing touched. They do reach the room, whose
             * "Top rated" and "Favourites" shelves are filters on exactly those values; and a
             * trashed item has left every shelf and playlist as well as the grid.
             */
            if (input.action === "untag" || input.action === "tag") {
                invalidateVocabulary(queryClient);
            } else if (input.action === "trash") {
                invalidateListable(queryClient);
            } else {
                void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
                void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
            }

            onApplied(describeBulkResult(result));
        },
        onError: () => onApplied("Nothing was changed."),
    });

    /**
     * Naming a new playlist for the selection, or null.
     *
     * The menu used to end at "No playlists yet" — a dead end reached by exactly the person
     * most likely to want one, since a first playlist is nearly always made out of something
     * already picked out. The items travel with the create, so this is one request rather
     * than a create followed by an add that can fail on its own.
     *
     * Pinned unless switched off, the same as every other way a collection is made: a new one
     * is nearly always the one about to be reached for, and finding it absent from the sidebar
     * reads as the create having failed.
     */
    const [naming, setNaming] = useState<null | { name: string; pinned: boolean }>(null);

    const createPlaylist = useCreatePlaylist((playlist) => {
        setNaming(null);
        onApplied(`Added ${count} to ${playlist.name}`);
    });

    /**
     * The playlists this account may actually add to (§6).
     *
     * Sharing a playlist grants reading and nothing else, so a list shared by somebody else
     * is not somewhere this selection can go -- the server refuses it, and the menu was
     * offering it anyway. The item page's own picker has always filtered this way; the bulk
     * bar did not, which made "add forty items" the one route to a guaranteed 403.
     */
    const mineToAddTo = (playlists.data?.playlists ?? []).filter((playlist) => playlist.editable);

    const addToPlaylist = useAddPlaylistItems((result) => {
        onApplied(`${result.added} item${result.added === 1 ? "" : "s"} added`);
    });

    const busy =
        act.isPending || addToPlaylist.isPending || createPlaylist.isPending || refuse.isPending;
    const count = selected.length;

    return (
        <>
            <Paper className={classes.bar} shadow="md" radius="md" withBorder>
                <Group gap="sm" wrap="wrap" justify="center">
                    <Text size="sm" fw={500}>
                        {count} selected
                    </Text>

                    {/* First and filled when the library came from "Find untagged": ticking what
                        names the tag and filing it there is the whole of that session, and a
                        dialogue per page would be a confirmation for its own sake. */}
                    {suggestedTag && (
                        <Button
                            size="compact-sm"
                            color="brass"
                            loading={act.isPending}
                            disabled={busy}
                            onClick={() =>
                                act.mutate({
                                    action: "tag",
                                    kind: suggestedTag.kind,
                                    names: [suggestedTag.name],
                                    scope: suggestedTag.scope,
                                })
                            }
                        >
                            Add {suggestedTag.name}
                        </Button>
                    )}
                    {/* The other half of the same session: what names the tag but is somebody
                        else, said once, so the filter stops offering it. */}
                    {refusable && (
                        <Button
                            size="compact-sm"
                            variant="default"
                            loading={refuse.isPending}
                            disabled={busy}
                            onClick={() =>
                                refuse.mutate(selected, {
                                    onSuccess: (result) =>
                                        onApplied(
                                            `${result.refused} item${result.refused === 1 ? "" : "s"} will not be offered as ${refusable.name} again`
                                        ),
                                    onError: () => onApplied("Nothing was changed."),
                                })
                            }
                        >
                            Not {refusable.name}
                        </Button>
                    )}
                    <Button
                        size="compact-sm"
                        variant="default"
                        disabled={busy}
                        onClick={() => setTagging(true)}
                    >
                        Tag
                    </Button>
                    <Button
                        size="compact-sm"
                        variant="default"
                        disabled={busy}
                        onClick={() => setUntagging(true)}
                    >
                        Untag
                    </Button>

                    <Group gap={4} align="center">
                        <Text size="xs" c="dimmed">
                            Rate
                        </Text>
                        <Rating
                            size="sm"
                            color="brass"
                            value={0}
                            readOnly={busy}
                            onChange={(rating) => act.mutate({ action: "rate", rating })}
                        />
                        {/* The only way back to unrated, and it has to be reachable: a star
                            control can set a rating but can never clear one. */}
                        <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            disabled={busy}
                            aria-label="Clear rating"
                            title="Clear rating"
                            onClick={() => act.mutate({ action: "rate", rating: null })}
                        >
                            <CloseGlyph size={14} />
                        </ActionIcon>
                    </Group>

                    <Button
                        size="compact-sm"
                        variant="default"
                        color="oxblood"
                        disabled={busy}
                        onClick={() => act.mutate({ action: "favorite", favorite: true })}
                    >
                        ♥
                    </Button>
                    <Button
                        size="compact-sm"
                        variant="default"
                        disabled={busy}
                        onClick={() => act.mutate({ action: "favorite", favorite: false })}
                    >
                        ♡
                    </Button>

                    <Menu withinPortal position="top">
                        <Menu.Target>
                            <Button size="compact-sm" variant="default" disabled={busy}>
                                + Playlist
                            </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                            {/* First, and present whether or not any exist: the commonest
                                reason to open this menu with things selected is to make a
                                playlist out of them. */}
                            <Menu.Item onClick={() => setNaming({ name: "", pinned: true })}>
                                New playlist…
                            </Menu.Item>

                            {mineToAddTo.length > 0 && <Menu.Divider />}

                            {mineToAddTo.map((playlist) => (
                                <Menu.Item
                                    key={playlist.id}
                                    onClick={() =>
                                        addToPlaylist.mutate({
                                            id: playlist.id,
                                            mediaIds: selected,
                                        })
                                    }
                                >
                                    {playlist.name}
                                </Menu.Item>
                            ))}
                        </Menu.Dropdown>
                    </Menu>

                    {/* Absent rather than disabled without the scope: a greyed Trash button
                        invites somebody to work out why, and the answer is not something they
                        can act on (§18.1). */}
                    {canDelete && (
                        <Button
                            size="compact-sm"
                            variant="subtle"
                            color="oxblood"
                            disabled={busy}
                            leftSection={<TrashGlyph size={14} />}
                            onClick={() => setConfirmTrash(true)}
                        >
                            Move to bin
                        </Button>
                    )}

                    <Button size="compact-sm" variant="subtle" onClick={onClear} disabled={busy}>
                        Clear
                    </Button>
                </Group>
            </Paper>

            <BulkTagDialog
                key={suggestedTag?.name ?? ""}
                opened={tagging}
                onClose={() => setTagging(false)}
                target={{ type: "selection", mediaIds: selected }}
                onApplied={onApplied}
                suggested={suggestedTag}
            />

            <UntagDialog
                opened={untagging}
                onClose={() => setUntagging(false)}
                selected={selected}
                onRemove={(tagIds) => {
                    act.mutate({ action: "untag", tagIds });
                    setUntagging(false);
                }}
                busy={busy}
            />

            <Modal
                opened={naming !== null}
                onClose={() => setNaming(null)}
                title={`New playlist from ${count} item${count === 1 ? "" : "s"}`}
                centered
            >
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        placeholder="Evening"
                        value={naming?.name ?? ""}
                        maxLength={200}
                        data-autofocus
                        // Read here rather than inside the updater: React clears
                        // `currentTarget` once the handler returns, and a functional update
                        // runs later.
                        onChange={(event) => {
                            const name = event.currentTarget.value;

                            setNaming((prev) => (prev ? { ...prev, name } : prev));
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && naming?.name.trim()) {
                                createPlaylist.mutate({
                                    name: naming.name.trim(),
                                    mediaIds: selected,
                                    visibility: "private",
                                    pinned: naming.pinned,
                                });
                            }
                        }}
                    />

                    <Switch
                        label="Pin to the sidebar"
                        color="brass"
                        checked={naming?.pinned ?? false}
                        onChange={(event) => {
                            const pinned = event.currentTarget.checked;

                            setNaming((prev) => (prev ? { ...prev, pinned } : prev));
                        }}
                    />

                    {createPlaylist.error && (
                        <Alert color="oxblood" variant="light">
                            {createPlaylist.error instanceof ApiError
                                ? createPlaylist.error.message
                                : "Could not create the playlist"}
                        </Alert>
                    )}

                    {/* Said plainly: the items are added to a list, not moved out of the
                        library, and "new playlist" beside a selection could read either way. */}
                    <Text size="xs" c="dimmed">
                        The items stay where they are. A playlist is an order, not a place.
                    </Text>

                    <Group justify="flex-end">
                        <Button variant="subtle" onClick={() => setNaming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            loading={createPlaylist.isPending}
                            disabled={!naming?.name.trim()}
                            onClick={() =>
                                naming?.name.trim() &&
                                createPlaylist.mutate({
                                    name: naming.name.trim(),
                                    mediaIds: selected,
                                    visibility: "private",
                                    pinned: naming.pinned,
                                })
                            }
                        >
                            Create with {count} item{count === 1 ? "" : "s"}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={confirmTrash}
                onClose={() => setConfirmTrash(false)}
                title={`Move ${count} items to the bin`}
                centered
            >
                <Stack gap="sm">
                    <Text size="sm">
                        The original files are moved out of their library and kept in the bin until
                        it is purged. Items on read-only libraries are left alone and reported.
                    </Text>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setConfirmTrash(false)}>
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={busy}
                            onClick={() => {
                                act.mutate({ action: "trash" });
                                setConfirmTrash(false);
                            }}
                        >
                            Move to bin
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
