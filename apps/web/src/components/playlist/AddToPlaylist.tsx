"use client";

import { useState } from "react";
import { Button, Group, Menu, Modal, Stack, Text, TextInput } from "@mantine/core";

import { useAddPlaylistItems, useCreatePlaylist, usePlaylists } from "@/lib/api/playlists";

/**
 * Putting the item you are watching into a list (§14b).
 *
 * A playlist with no way to add to it is furniture, and this is the narrowest way in that
 * works: one item, from the page where you have just decided you want it. Adding a whole
 * selection belongs to bulk select, which is a different feature with its own toolbar.
 *
 * Only the viewer's own lists are offered. A shared playlist grants reading and nothing else,
 * so a list somebody else owns has nowhere to put this even though it is visible.
 */

/**
 * `iconOnly` for a phone, where four labelled actions beside the stars overflow the row: the
 * "+" stays, with its name in the accessible label and the tooltip.
 */
export const AddToPlaylist: React.FC<{ mediaId: string; iconOnly?: boolean }> = ({
    mediaId,
    iconOnly = false,
}) => {
    const { data } = usePlaylists();

    const [naming, setNaming] = useState<string | null>(null);
    const [added, setAdded] = useState<string | null>(null);

    const add = useAddPlaylistItems();
    const create = useCreatePlaylist((playlist) => {
        setNaming(null);
        addTo(playlist.id, playlist.name);
    });

    const addTo = (id: string, name: string) =>
        add.mutate(
            { id, mediaIds: [mediaId] },
            {
                onSuccess: (result) =>
                    // "Already there" is not a failure and not an addition; saying which of
                    // the two happened is the whole value of the confirmation.
                    setAdded(result.added > 0 ? `Added to ${name}` : `Already in ${name}`),
            }
        );

    const mine = (data?.playlists ?? []).filter((playlist) => playlist.editable);

    return (
        <>
            <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                    {/* The height of the other actions on its row -- it was a 22px text
                        button beside a 36px one, reading as a different system. */}
                    <Button
                        variant="default"
                        loading={add.isPending}
                        aria-label="Add to a playlist"
                        title="Add to a playlist"
                    >
                        {iconOnly ? "+" : "+ Playlist"}
                    </Button>
                </Menu.Target>

                <Menu.Dropdown>
                    {mine.length > 0 && (
                        <>
                            <Menu.Label>Add to</Menu.Label>
                            {mine.map((playlist) => (
                                <Menu.Item
                                    key={playlist.id}
                                    onClick={() => addTo(playlist.id, playlist.name)}
                                >
                                    {playlist.name}
                                </Menu.Item>
                            ))}
                            <Menu.Divider />
                        </>
                    )}

                    <Menu.Item onClick={() => setNaming("")}>New playlist…</Menu.Item>
                </Menu.Dropdown>
            </Menu>

            <Modal
                opened={naming !== null}
                onClose={() => setNaming(null)}
                title="New playlist"
                centered
            >
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        placeholder="Sunday evening"
                        data-autofocus
                        value={naming ?? ""}
                        onChange={(event) => setNaming(event.currentTarget.value)}
                        onKeyDown={(event) =>
                            event.key === "Enter" &&
                            naming?.trim() &&
                            create.mutate({
                                name: naming.trim(),
                                visibility: "private",
                                pinned: true,
                            })
                        }
                        error={create.isError ? (create.error as Error).message : null}
                    />
                    <Text size="xs" c="dimmed">
                        This item goes in as its first entry.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="subtle" color="gray" onClick={() => setNaming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            loading={create.isPending}
                            disabled={!naming?.trim()}
                            onClick={() =>
                                naming?.trim() &&
                                create.mutate({
                                    name: naming.trim(),
                                    visibility: "private",
                                    pinned: true,
                                })
                            }
                        >
                            Create and add
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={added !== null}
                onClose={() => setAdded(null)}
                withCloseButton={false}
                centered
                size="sm"
            >
                <Stack gap="md">
                    <Text size="sm">{added}</Text>
                    <Group justify="flex-end">
                        <Button variant="subtle" color="gray" onClick={() => setAdded(null)}>
                            Done
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
