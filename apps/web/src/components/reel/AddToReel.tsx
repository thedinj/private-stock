"use client";

import { useState } from "react";
import { Button, Menu, Modal, Stack, TextInput } from "@mantine/core";

import type { Clip } from "@private-stock/core";

import { useAddReelItems, useCreateReel, useOwnReels } from "@/lib/api/reels";

/**
 * Putting a span into a reel, from wherever it is showing (§14d).
 *
 * Shaped after `AddToPlaylist`, which solves the same problem one layer up: the narrowest way in
 * that works, from the page where you have just decided you want it.
 *
 * Only this person's own reels are offered, and here that is the **owner invariant** rather than
 * the courtesy it is for playlists: a reel holds nothing but its owner's clips, so a reel
 * somebody else shared is not a place this span could go even in principle. The API refuses it
 * too — nothing should offer a gesture the server will reject.
 *
 * Ordered by **most recently updated**, because the reel you are filling is almost always the one
 * you just made. The Florida case is one sitting spent gathering forty spans into a single reel,
 * not forty reels touched once each.
 */

interface AddToReelProps {
    clip: Clip;
    label?: string;
}

export const AddToReel: React.FC<AddToReelProps> = ({ clip, label = "+ Reel" }) => {
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const [done, setDone] = useState<string | null>(null);

    const reels = useOwnReels();
    const add = useAddReelItems();
    const create = useCreateReel(() => {
        setNaming(false);
        setName("");
    });

    const mine = reels.data?.items ?? [];

    return (
        <>
            <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                    <Button size="compact-xs" variant="subtle" color="gray" loading={add.isPending}>
                        {done ?? label}
                    </Button>
                </Menu.Target>

                <Menu.Dropdown>
                    {mine.length > 0 && (
                        <>
                            <Menu.Label>Add to</Menu.Label>
                            {mine.map((reel) => (
                                <Menu.Item
                                    key={reel.id}
                                    onClick={() =>
                                        add.mutate(
                                            { id: reel.id, input: { clipIds: [clip.id] } },
                                            { onSuccess: () => setDone(`In ${reel.name}`) }
                                        )
                                    }
                                >
                                    {reel.name}
                                </Menu.Item>
                            ))}
                            <Menu.Divider />
                        </>
                    )}
                    <Menu.Item onClick={() => setNaming(true)}>New reel…</Menu.Item>
                </Menu.Dropdown>
            </Menu>

            <Modal opened={naming} onClose={() => setNaming(false)} title="New reel" centered>
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                        data-autofocus
                    />
                    <Button
                        disabled={name.trim() === ""}
                        loading={create.isPending}
                        onClick={() =>
                            /*
                             * Created with the span already in it, so the reel and its first clip
                             * arrive together. Two requests can half-fail, and what survives is an
                             * empty reel named after something it does not contain — which reads
                             * as the feature having worked and then lost everything (§14b).
                             */
                            create.mutate({
                                name: name.trim(),
                                visibility: "private",
                                clipIds: [clip.id],
                            })
                        }
                    >
                        Create with this clip
                    </Button>
                </Stack>
            </Modal>
        </>
    );
};
