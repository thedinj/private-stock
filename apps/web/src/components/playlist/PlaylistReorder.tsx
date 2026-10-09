"use client";

import { useState } from "react";
import { ActionIcon, Box, Group, Image, Paper, Stack, Text } from "@mantine/core";

import type { MediaListItem } from "@private-stock/core";
import { ArrowDownGlyph, ArrowUpGlyph, CloseGlyph } from "@/components/media/Glyph";

/**
 * Arranging a playlist, which is the one place its stored order is written (§14b).
 *
 * A vertical list rather than the grid, because ordering is the task: a grid asks you to
 * reason about an order in two dimensions, and "third" is easy to see in a column and hard to
 * see in a rack. It also gives each row room for a handle and a pair of buttons without
 * covering the cover art.
 *
 * Both ways of moving an item are offered, and the pair is deliberate. Dragging is the natural
 * gesture and is what §14b describes; it is also unavailable to anyone on a phone, since HTML
 * drag events do not fire for touch. The arrows are the same operation stated as a control, so
 * the feature is not desktop-only — and they are the accessible route as well, being ordinary
 * buttons in the tab order.
 *
 * Moves are sent as one item and a destination, never as the whole sequence: a client holding
 * a stale copy of a long playlist could otherwise drop the members it never loaded.
 */

interface PlaylistReorderProps {
    items: MediaListItem[];
    /** Index of the first row within the whole playlist, so a move on page 2 means page 2. */
    offset: number;
    onMove: (mediaId: string, toIndex: number) => void;
    onRemove: (mediaId: string) => void;
    busy: boolean;
}

export const PlaylistReorder: React.FC<PlaylistReorderProps> = ({
    items,
    offset,
    onMove,
    onRemove,
    busy,
}) => {
    /**
     * The row being dragged, and the row it is currently over.
     *
     * Held here rather than read from the drag event because `dataTransfer` is not readable
     * during `dragover` in any browser — only on `drop` — so the highlight would otherwise
     * have nothing to go on.
     */
    const [dragging, setDragging] = useState<string | null>(null);
    const [over, setOver] = useState<string | null>(null);

    const drop = (targetId: string) => {
        const from = items.findIndex((item) => item.id === dragging);
        const to = items.findIndex((item) => item.id === targetId);

        setDragging(null);
        setOver(null);

        if (from === -1 || to === -1 || from === to) {
            return;
        }

        onMove(items[from]!.id, offset + to);
    };

    return (
        <Stack gap="xs">
            {items.map((item, index) => (
                <Paper
                    key={item.id}
                    withBorder
                    p="xs"
                    draggable={!busy}
                    onDragStart={() => setDragging(item.id)}
                    onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                    }}
                    // Without preventDefault the browser refuses the drop outright: the
                    // default handling of dragover is "this is not a drop target".
                    onDragOver={(event) => {
                        event.preventDefault();
                        setOver(item.id);
                    }}
                    onDrop={(event) => {
                        event.preventDefault();
                        drop(item.id);
                    }}
                    style={{
                        opacity: dragging === item.id ? 0.4 : 1,
                        borderColor:
                            over === item.id && dragging !== item.id
                                ? "var(--mantine-color-brass-5)"
                                : undefined,
                        cursor: busy ? "progress" : "grab",
                    }}
                >
                    <Group gap="sm" wrap="nowrap">
                        <Text size="sm" c="dimmed" w={32} ta="right" style={{ flexShrink: 0 }}>
                            {offset + index + 1}
                        </Text>

                        <Box w={64} h={36} style={{ flexShrink: 0, overflow: "hidden" }}>
                            {item.coverUrl && (
                                <Image
                                    src={item.coverUrl}
                                    alt=""
                                    w={64}
                                    h={36}
                                    fit="cover"
                                    radius="sm"
                                />
                            )}
                        </Box>

                        <Text size="sm" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
                            {item.title}
                        </Text>

                        {/* Touch targets, and the only way to reorder without a mouse. */}
                        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="lg"
                                aria-label="Move up"
                                disabled={busy || offset + index === 0}
                                onClick={() => onMove(item.id, offset + index - 1)}
                            >
                                <ArrowUpGlyph size={18} />
                            </ActionIcon>
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="lg"
                                aria-label="Move down"
                                disabled={busy}
                                onClick={() => onMove(item.id, offset + index + 1)}
                            >
                                <ArrowDownGlyph size={18} />
                            </ActionIcon>
                            <ActionIcon
                                variant="subtle"
                                color="oxblood"
                                size="lg"
                                aria-label="Remove from playlist"
                                disabled={busy}
                                onClick={() => onRemove(item.id)}
                            >
                                <CloseGlyph size={16} />
                            </ActionIcon>
                        </Group>
                    </Group>
                </Paper>
            ))}
        </Stack>
    );
};
