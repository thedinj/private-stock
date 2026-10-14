"use client";

import Link from "next/link";
import { Anchor, Badge, Box, Checkbox, Group, Paper, Stack, Text } from "@mantine/core";

import type { Clip } from "@private-stock/core";

import { rememberReturn } from "@/lib/returnTo";

import { ClipTagLine } from "./ClipTagLine";
import { ClipThumb } from "./ClipThumb";

/**
 * One clip on the browser's wall (§14d).
 *
 * A card rather than a row, because a clip is a **picture of a moment**: the thumbnail is the part
 * anybody recognises it by, and a row gives that the least space while spending the most on
 * horizontal rules. The wall also reads at a glance the way a shelf of reels does, which is what
 * makes forty of them something you can scan rather than read.
 *
 * Everything that is not the picture sits on it. The running time and the speed go in the corner
 * the way they do on any video thumbnail, and the checkbox in the other — so the card below the
 * picture carries only the things that are words: what this clip is, how it is tagged, and what
 * it came from.
 */

const formatRun = (ms: number): string => {
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);

    return minutes > 0 ? `${minutes}:${String(total % 60).padStart(2, "0")}` : `${total}s`;
};

interface ClipCardProps {
    clip: Clip;
    selected: boolean;
    onToggle: () => void;
    /** Hidden when the wall is already grouped by item, where it would be on every card. */
    showSource?: boolean;
}

export const ClipCard: React.FC<ClipCardProps> = ({
    clip,
    selected,
    onToggle,
    showSource = true,
}) => (
    <Paper
        withBorder
        radius="sm"
        p={6}
        // Not for a click on the link to the item, which opens it. That link used to stop its
        // click from reaching here, which also stopped it reaching the page turn's listener
        // (`PageTurn`) -- the listener reads a stopped click as a cancelled one, so the link
        // did nothing at all.
        onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) return;
            onToggle();
        }}
        style={{
            cursor: "pointer",
            // The whole card is the target: a checkbox is a small thing to hit forty times.
            borderColor: selected ? "var(--mantine-color-brass-5)" : undefined,
        }}
    >
        <Stack gap={6}>
            <ClipThumb clip={clip} square>
                {/*
                 * Always drawn, not only on hover: selecting is what this page is *for*, and a
                 * control that appears when the pointer finds it is a control nobody discovers on
                 * a touchscreen.
                 *
                 * On its own scrim, like the running time opposite. A frame can be any colour —
                 * these are bright cartoon greens and pinks — and an unchecked box is a thin
                 * outline that simply disappears against half of them.
                 */}
                <Box
                    style={{
                        position: "absolute",
                        top: 5,
                        left: 5,
                        display: "flex",
                        background: "rgba(0, 0, 0, 0.55)",
                        borderRadius: 4,
                        padding: 3,
                    }}
                >
                    <Checkbox
                        checked={selected}
                        onChange={onToggle}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${clip.label ?? "clip"}`}
                        size="xs"
                    />
                </Box>

                <Group gap={4} wrap="nowrap" style={{ position: "absolute", right: 6, bottom: 6 }}>
                    {clip.speed !== null && (
                        <Badge size="xs" variant="filled" color="brass">
                            {clip.speed}×
                        </Badge>
                    )}
                    <Box
                        style={{
                            background: "rgba(0, 0, 0, 0.72)",
                            borderRadius: 3,
                            padding: "1px 5px",
                        }}
                    >
                        <Text size="xs" c="white" fw={600} lh={1.4}>
                            {formatRun(clip.runMs)}
                        </Text>
                    </Box>
                </Group>
            </ClipThumb>

            <Stack gap={0}>
                <Group gap={6} wrap="nowrap" justify="space-between">
                    <Text size="xs" fw={600} lineClamp={1}>
                        {clip.label ?? formatRun(clip.runMs)}
                    </Text>
                    {/* The whole reason a clip is worth keeping track of, so it stays a word
                        rather than becoming another pill on the picture. */}
                    {clip.reelCount > 0 && (
                        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                            in {clip.reelCount}
                        </Text>
                    )}
                </Group>

                <ClipTagLine tags={clip.tags} />

                {showSource && (
                    <Anchor
                        component={Link}
                        href={`/media/${clip.mediaId}`}
                        c="dimmed"
                        size="xs"
                        lineClamp={1}
                        onClick={rememberReturn}
                    >
                        {clip.mediaTitle}
                    </Anchor>
                )}
            </Stack>
        </Stack>
    </Paper>
);
