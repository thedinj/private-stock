"use client";

import Link from "next/link";
import { Badge, Box, Group, Paper, Stack, Text } from "@mantine/core";

import type { Reel } from "@private-stock/core";

/**
 * A reel on the index (§14d).
 *
 * Modelled on `PlaylistCard`, with one thing a playlist card does not carry: a **running time**.
 * That is the number people choose a reel by — "have I got twenty minutes for this" — and it is
 * not the sum of the spans once any of them has a speed, so it is computed on the server and
 * arrives here already correct.
 *
 * The mosaic is sampled from across the reel rather than off its front, so the card is a glimpse
 * of the whole thing and not of its opening shot. Each viewer's own: a span in a library this
 * account cannot reach contributes nothing, because a thumbnail is as much a disclosure as a row.
 */

const formatRun = (ms: number): string => {
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);

    return minutes > 0 ? `${minutes}:${String(total % 60).padStart(2, "0")}` : `${total}s`;
};

const formatWhen = (iso: string): string => {
    const date = new Date(`${iso.replace(" ", "T")}Z`);

    return Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export const ReelCard: React.FC<{ reel: Reel }> = ({ reel }) => (
    <Paper
        component={Link}
        href={`/reels/${reel.id}`}
        withBorder
        radius="sm"
        p="sm"
        style={{ textDecoration: "none", color: "inherit" }}
    >
        <Stack gap="xs">
            {/*
             * Four covers in a fixed grid, so a reel with one cover and a reel with four are the
             * same shape on the wall. An empty mosaic is normal — a new reel, or one whose covers
             * have not been generated yet.
             */}
            <Box
                style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 2,
                    aspectRatio: "16 / 9",
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "var(--ps-well)",
                }}
            >
                {reel.covers.slice(0, 4).map((url) => (
                    <Box key={url} style={{ background: `center / cover no-repeat url(${url})` }} />
                ))}
            </Box>

            <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text fw={600} size="sm" lineClamp={1}>
                    {reel.name}
                </Text>
                {/* Only on a shared reel: saying "private" on everything else would be noise on
                    the common case. */}
                {reel.visibility === "shared" && (
                    <Badge size="xs" variant="light" color="brass">
                        Shared
                    </Badge>
                )}
            </Group>

            <Text size="xs" c="dimmed">
                {reel.itemCount} clip{reel.itemCount === 1 ? "" : "s"} · {formatRun(reel.runningMs)}
                {reel.editable ? "" : ` · ${reel.ownerName}`} · {formatWhen(reel.updatedAt)}
            </Text>
        </Stack>
    </Paper>
);
