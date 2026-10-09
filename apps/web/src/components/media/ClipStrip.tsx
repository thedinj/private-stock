"use client";

import { useState } from "react";
import { ActionIcon, Badge, Group, Paper, Stack, Text } from "@mantine/core";

import type { Clip } from "@private-stock/core";

import { ClipThumb } from "./ClipThumb";
import { ClipEditor } from "./ClipEditor";
import { ClipTagLine } from "./ClipTagLine";
import { SectionLabel } from "./SectionLabel";
import { AddToReel } from "../reel/AddToReel";
import { MoreGlyph, PlayGlyph } from "@/components/media/Glyph";

/**
 * This viewer's spans of one item, under the player (§14d).
 *
 * **Yours only.** A clip is private raw material, so somebody else's marks on this file are not
 * listed here or anywhere else — the single place a span reaches another account is inside a
 * reel they can open.
 *
 * In **timeline order, never creation order**, which is §9's rule for the frame strip and holds
 * for the same reason: scanning the strip is scanning forward through the item, and sorting by
 * when each was taken shunts everything along by one every time somebody marks another.
 *
 * It lives under the player rather than behind the details drawer. A clip is made with the
 * player in front of you, and burying the shelf that shows the result would repeat the mistake
 * §9 records about the capture button.
 */

const formatTime = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);

    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

interface ClipStripProps {
    clips: Clip[];
    coverUrl?: string | null;
    onPlay: (clip: Clip) => void;
}

export const ClipStrip: React.FC<ClipStripProps> = ({ clips, coverUrl = null, onPlay }) => {
    const [editing, setEditing] = useState<Clip | null>(null);

    if (clips.length === 0) {
        return null;
    }

    return (
        <Stack gap="xs">
            <SectionLabel>Clips</SectionLabel>

            <Group gap="xs" wrap="wrap">
                {clips.map((clip) => (
                    <Paper key={clip.id} withBorder p={6} radius="sm" w={148}>
                        <Stack gap={4}>
                            <ClipThumb clip={clip} width={136} fallbackUrl={coverUrl} />

                            <Text size="xs" fw={600} lineClamp={1}>
                                {clip.label ??
                                    `${formatTime(clip.startMs)}–${formatTime(clip.endMs)}`}
                            </Text>
                            <ClipTagLine tags={clip.tags} />

                            <Group gap={4} justify="space-between" wrap="nowrap">
                                <Group gap={4} wrap="nowrap">
                                    <Text size="xs" c="dimmed">
                                        {formatTime(clip.runMs)}
                                    </Text>
                                    {/* Only when somebody chose one: a badge on every clip is a
                                        badge nobody reads. */}
                                    {clip.speed !== null && (
                                        <Badge size="xs" variant="light" color="brass">
                                            {clip.speed}×
                                        </Badge>
                                    )}
                                    {/* "in 2" rather than "2 reels": the strip's cards are
                                        narrow, and the longer wording was being cut to "2 …",
                                        which says less than the number on its own. */}
                                    {clip.reelCount > 0 && (
                                        <Badge
                                            size="xs"
                                            variant="outline"
                                            color="gray"
                                            title={`In ${clip.reelCount} reel${clip.reelCount === 1 ? "" : "s"}`}
                                        >
                                            in {clip.reelCount}
                                        </Badge>
                                    )}
                                </Group>

                                <Group gap={2} wrap="nowrap">
                                    <ActionIcon
                                        size="sm"
                                        variant="subtle"
                                        aria-label="Play this clip"
                                        onClick={() => onPlay(clip)}
                                    >
                                        <PlayGlyph size={14} />
                                    </ActionIcon>

                                    <AddToReel clip={clip} label="+" />

                                    {/* Drawn only when the rule permits it, rather than drawn
                                        disabled — the house pattern (§9). */}
                                    {clip.editable && (
                                        <ActionIcon
                                            size="sm"
                                            variant="subtle"
                                            aria-label="Edit clip"
                                            onClick={() => setEditing(clip)}
                                        >
                                            <MoreGlyph size={16} />
                                        </ActionIcon>
                                    )}
                                </Group>
                            </Group>
                        </Stack>
                    </Paper>
                ))}
            </Group>

            {editing && <ClipEditor clip={editing} onClose={() => setEditing(null)} />}
        </Stack>
    );
};
