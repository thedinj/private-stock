"use client";

import { useState } from "react";
import { ActionIcon, Button, Group, Menu, Modal, Stack, Text, TextInput } from "@mantine/core";

import type { CollectionKind } from "@private-stock/core";

import { useDeletePlaylist, useSetPlaylistPin, useUpdatePlaylist } from "@/lib/api/playlists";
import {
    useDeleteSavedFilter,
    useSetSavedFilterPin,
    useUpdateSavedFilter,
} from "@/lib/api/savedFilters";

/**
 * A view's or a playlist's ⋯ on the Views & playlists page, in its row or on its tile (§14c).
 *
 * What a performer row's menu is to a tag: the one-off fixes without opening the thing first.
 * Pinning is offered on everything this viewer can see, because a pin is their own sidebar;
 * renaming and deleting only on their own, and absent rather than disabled elsewhere, since the
 * server refuses them.
 *
 * **Whose pin is written depends on whose collection it is.** On your own the owner's column is
 * the pin -- on a shared one it is the household's default too, which is the owner's to set. On
 * somebody else's it is this viewer's own decision, through the pin route, so taking a curated
 * view out of your sidebar does not take it out of anybody else's (§14c).
 */

interface CollectionMenuProps {
    kind: CollectionKind;
    collection: { id: string; name: string; pinned: boolean; editable: boolean };
}

export const CollectionMenu: React.FC<CollectionMenuProps> = ({ kind, collection }) => {
    const [renaming, setRenaming] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const noun = kind === "filter" ? "view" : "playlist";

    const updateView = useUpdateSavedFilter();
    const pinView = useSetSavedFilterPin();
    const deleteView = useDeleteSavedFilter();
    const updatePlaylist = useUpdatePlaylist();
    const pinPlaylist = useSetPlaylistPin();
    const deletePlaylist = useDeletePlaylist();

    const update = kind === "filter" ? updateView : updatePlaylist;
    const remove = kind === "filter" ? deleteView : deletePlaylist;

    const togglePin = () => {
        const pinned = !collection.pinned;

        if (collection.editable) {
            update.mutate({ id: collection.id, patch: { pinned } });
        } else {
            (kind === "filter" ? pinView : pinPlaylist).mutate({ id: collection.id, pinned });
        }
    };

    const rename = () => {
        const name = renaming?.trim();

        if (!name) {
            return;
        }

        update.mutate(
            { id: collection.id, patch: { name } },
            // Closed once the server has agreed, so a name already taken is shown, not lost.
            { onSuccess: () => setRenaming(null) }
        );
    };

    return (
        <>
            <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="lg"
                        aria-label={`Actions for ${collection.name}`}
                    >
                        <Text span fw={700} lh={1}>
                            ⋯
                        </Text>
                    </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                    <Menu.Item onClick={togglePin}>
                        {collection.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                    </Menu.Item>
                    {collection.editable && (
                        <>
                            <Menu.Item onClick={() => setRenaming(collection.name)}>
                                Rename…
                            </Menu.Item>
                            <Menu.Item color="oxblood" onClick={() => setDeleting(true)}>
                                Delete…
                            </Menu.Item>
                        </>
                    )}
                </Menu.Dropdown>
            </Menu>

            <Modal
                opened={renaming !== null}
                onClose={() => setRenaming(null)}
                title={`Rename this ${noun}`}
                centered
            >
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        data-autofocus
                        value={renaming ?? ""}
                        onChange={(event) => setRenaming(event.currentTarget.value)}
                        onKeyDown={(event) => event.key === "Enter" && rename()}
                        error={update.isError ? (update.error as Error).message : null}
                    />
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setRenaming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            disabled={!renaming?.trim()}
                            loading={update.isPending}
                            onClick={rename}
                        >
                            Rename
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={deleting}
                onClose={() => setDeleting(false)}
                title={`Delete “${collection.name}”?`}
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        {kind === "filter"
                            ? "The saved view is deleted. Nothing happens to the items it shows — they stay in your library."
                            : "The list and its order are deleted. Nothing happens to the items themselves — they stay in your library."}
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setDeleting(false)}>
                            Keep it
                        </Button>
                        <Button
                            color="oxblood"
                            loading={remove.isPending}
                            onClick={() =>
                                remove.mutate(collection.id, {
                                    onSuccess: () => setDeleting(false),
                                })
                            }
                        >
                            Delete {noun}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
