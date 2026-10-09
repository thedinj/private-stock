"use client";

import Link from "next/link";
import {
    Anchor,
    AspectRatio,
    Badge,
    Box,
    Checkbox,
    Image,
    Paper,
    Stack,
    Text,
} from "@mantine/core";

import type { Capture } from "@private-stock/core";

import { rememberReturn } from "@/lib/returnTo";
import { formatTimecode } from "@/lib/timecode";

/**
 * One capture on the Captures page (§9).
 *
 * Modelled on `ClipCard`, with one deliberate difference: **clicking the picture enlarges it**
 * rather than selecting it. A clip's thumbnail is only a reminder of a span, and selecting is
 * that page's whole purpose; a capture *is* the picture, and clicking a picture means looking
 * at it — the rule `FrameLightbox` was written for. Selecting has its own box, with a target
 * big enough to hit on a phone.
 *
 * The link underneath opens the video at the moment the still was taken, which is the other
 * thing anybody does with one.
 */

interface CaptureCardProps {
    capture: Capture;
    selected: boolean;
    onToggle: () => void;
    onOpen: () => void;
    /** Hidden when the wall is already grouped by item, where it would be on every card. */
    showSource?: boolean;
}

export const CaptureCard: React.FC<CaptureCardProps> = ({
    capture,
    selected,
    onToggle,
    onOpen,
    showSource = true,
}) => {
    const at = capture.atMs === null ? null : formatTimecode(capture.atMs);
    const href =
        capture.atMs === null
            ? `/media/${capture.mediaId}`
            : `/media/${capture.mediaId}?at=${capture.atMs}`;

    return (
        <Paper
            withBorder
            radius="sm"
            p={6}
            style={{ borderColor: selected ? "var(--mantine-color-brass-5)" : undefined }}
        >
            <Stack gap={4}>
                <Box pos="relative">
                    <AspectRatio ratio={16 / 9}>
                        <Image
                            src={capture.url}
                            alt={capture.label ?? `Capture from ${capture.mediaTitle}`}
                            fit="cover"
                            radius="xs"
                            loading="lazy"
                            onClick={onOpen}
                            style={{ cursor: "zoom-in" }}
                        />
                    </AspectRatio>

                    {/*
                     * The box is small; what it sits in is not. A 44px square in the corner
                     * catches the tap, so selecting a run of captures on a phone does not keep
                     * opening the lightbox instead. On a scrim, because a frame can be any
                     * colour and an unticked outline vanishes against half of them.
                     */}
                    <Box
                        onClick={onToggle}
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: 44,
                            height: 44,
                            display: "grid",
                            placeItems: "center",
                            cursor: "pointer",
                        }}
                    >
                        <Box
                            style={{
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
                                aria-label={`Select ${capture.label ?? "capture"}`}
                                size="xs"
                            />
                        </Box>
                    </Box>

                    {capture.isCover && (
                        <Badge
                            color="brass"
                            variant="filled"
                            size="xs"
                            style={{
                                position: "absolute",
                                top: 6,
                                right: 6,
                                pointerEvents: "none",
                            }}
                        >
                            Cover
                        </Badge>
                    )}

                    {at && (
                        <Box
                            style={{
                                position: "absolute",
                                right: 6,
                                bottom: 6,
                                background: "rgba(0, 0, 0, 0.72)",
                                borderRadius: 3,
                                padding: "1px 5px",
                                pointerEvents: "none",
                            }}
                        >
                            <Text size="xs" c="white" fw={600} lh={1.4}>
                                {at}
                            </Text>
                        </Box>
                    )}
                </Box>

                <Text size="xs" fw={600} lineClamp={1} c={capture.label ? undefined : "dimmed"}>
                    {capture.label ?? "Untitled capture"}
                </Text>

                {/* One link, tall enough to tap: the item, at the moment. Grouped, the heading
                    already names the item, so the link says only where in it. */}
                <Anchor
                    component={Link}
                    href={href}
                    prefetch={false}
                    onClick={rememberReturn}
                    c="dimmed"
                    size="xs"
                    style={{ minHeight: 44, display: "flex", alignItems: "center", minWidth: 0 }}
                >
                    <Text span inherit truncate>
                        {showSource
                            ? at
                                ? `${capture.mediaTitle} · ${at}`
                                : capture.mediaTitle
                            : at
                              ? `Open at ${at}`
                              : "Open video"}
                    </Text>
                </Anchor>
            </Stack>
        </Paper>
    );
};
