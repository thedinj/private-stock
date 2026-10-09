"use client";

import { useState } from "react";
import {
    Alert,
    Button,
    Divider,
    Group,
    Modal,
    Select,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

import type { Clip } from "@private-stock/core";

import { useClipDetail, useDeleteClip, useUpdateClip } from "@/lib/api/reels";

import { ClipTagEditor } from "./ClipTagEditor";

/**
 * Retiming, renaming or discarding a span (§14d).
 *
 * The span is the **single source of truth** — no timecodes are copied onto a reel — so changing
 * it changes every reel holding it. The cost of that is paid here, before the press, in three
 * ways:
 *
 *  - The dialogue says which reels, by name. It can name **all** of them because a reel holds
 *    nothing but its owner's clips, so every reel this reaches belongs to the person reading.
 *  - The confirm button says what it will do — "Change it in 2 reels" — rather than "Save".
 *  - Both sentences are **absent at zero**. A warning that is always there is a warning nobody
 *    reads, and most clips are in no reel at all.
 *
 * Discarding cascades rather than refusing, for the same reason: there is no stranger's
 * arrangement to protect, so a refusal would only be a veto the person could not act on.
 *
 * Tags save chip by chip, like an item's, so Save is only about the name, speed and span. They are
 * offered to the clip's owner alone: an administrator editing an unattributed clip would be
 * writing tags nobody can see (§14d "Tagging clips").
 */

const SPEEDS = [
    { value: "", label: "Normal speed" },
    { value: "0.25", label: "0.25×" },
    { value: "0.5", label: "0.5×" },
    { value: "2", label: "2×" },
    { value: "4", label: "4×" },
];

const list = (names: string[]): string =>
    names.length <= 1
        ? (names[0] ?? "")
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

interface ClipEditorProps {
    clip: Clip;
    onClose: () => void;
}

export const ClipEditor: React.FC<ClipEditorProps> = ({ clip, onClose }) => {
    const [label, setLabel] = useState(clip.label ?? "");
    const [speed, setSpeed] = useState<string | null>(
        clip.speed === null ? "" : String(clip.speed)
    );

    const detail = useClipDetail(clip.id);
    const update = useUpdateClip();
    const remove = useDeleteClip(() => onClose());

    const reels = detail.data?.reels ?? [];
    const names = reels.map((reel) => reel.name);
    const changed =
        label !== (clip.label ?? "") || (speed === "" ? null : Number(speed)) !== clip.speed;

    return (
        <Modal opened onClose={onClose} title="Edit clip" centered>
            <Stack gap="md">
                <TextInput
                    label="Name"
                    placeholder="optional"
                    value={label}
                    onChange={(event) => setLabel(event.currentTarget.value)}
                />

                <Select
                    label="Speed"
                    data={SPEEDS}
                    value={speed}
                    onChange={setSpeed}
                    allowDeselect={false}
                    description="How fast this span is meant to be seen. Multiplies with the viewer's own rate."
                />

                {clip.mine && (
                    <>
                        <Divider />
                        <ClipTagEditor
                            clipId={clip.id}
                            mediaId={clip.mediaId}
                            tags={detail.data?.tags ?? clip.tags}
                        />
                        <Divider />
                    </>
                )}

                {reels.length > 0 && (
                    <Alert color="brass" variant="light" title="This clip is in use">
                        <Text size="sm">
                            It is in {list(names)}. Changing it changes what{" "}
                            {reels.length === 1 ? "that reel" : "those reels"} plays.
                        </Text>
                    </Alert>
                )}

                <Group justify="space-between">
                    <Button
                        variant="subtle"
                        color="oxblood"
                        loading={remove.isPending}
                        onClick={() => remove.mutate({ id: clip.id, mediaId: clip.mediaId })}
                    >
                        {reels.length > 0
                            ? `Discard, and remove from ${reels.length} reel${reels.length === 1 ? "" : "s"}`
                            : "Discard"}
                    </Button>

                    <Group gap="xs">
                        <Button variant="default" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            disabled={!changed}
                            loading={update.isPending}
                            onClick={() =>
                                update.mutate(
                                    {
                                        id: clip.id,
                                        patch: {
                                            label: label.trim() === "" ? null : label.trim(),
                                            speed: speed === "" ? null : Number(speed),
                                        },
                                    },
                                    { onSuccess: onClose }
                                )
                            }
                        >
                            {reels.length > 0
                                ? `Change it in ${reels.length} reel${reels.length === 1 ? "" : "s"}`
                                : "Save"}
                        </Button>
                    </Group>
                </Group>
            </Stack>
        </Modal>
    );
};
