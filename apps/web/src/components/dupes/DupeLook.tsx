"use client";

import { useState } from "react";
import { Anchor, Box, Button, Group, Popover, SimpleGrid, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";

import type { DupeMember, SpriteCue } from "@private-stock/core";

import { FileName } from "@/components/faces/FileName";
import { mediaDetailQuery } from "@/lib/api/media";
import { useSpriteCues } from "@/lib/api/sprites";
import { formatDuration } from "@/lib/dupeTriage";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

/**
 * "Look" on a copy (§10i), as on a face (§5f "Checking faces quickly"): a closer look in a popover
 * over the sheet, and "Play it here" for what the closer look cannot settle.
 *
 * The closer look is the video across its length rather than its cover. Two look-alikes are
 * usually alike at the moment the cover was taken -- the same room, the same light -- and a
 * row of moments from start to end is what tells the same video from another one shot there.
 */

/** Moments shown across the video: two rows of four. */
const MOMENTS = 8;

/** Cues spread evenly from start to end. */
const spread = (cues: SpriteCue[], count: number): SpriteCue[] =>
    cues.length <= count
        ? cues
        : Array.from(
              { length: count },
              (_, index) => cues[Math.round(((cues.length - 1) * index) / (count - 1))]
          );

/** One sprite tile, drawn at `width` pixels wide. */
const Tile: React.FC<{ cue: SpriteCue; width: number }> = ({ cue, width }) => {
    const scale = width / cue.width;

    return (
        <Box
            w={width}
            h={cue.height * scale}
            style={{ overflow: "hidden", borderRadius: 3, background: "var(--ps-well)" }}
        >
            <Box
                w={cue.width}
                h={cue.height}
                style={{
                    backgroundImage: `url(${cue.url})`,
                    backgroundPosition: `-${cue.x}px -${cue.y}px`,
                    backgroundRepeat: "no-repeat",
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                }}
            />
        </Box>
    );
};

/** The closer look itself: the video across its length, its file, and its numbers. */
const DupePeek: React.FC<{
    member: DupeMember;
    onPlay: () => void;
    onNotThis: (() => void) | null;
}> = ({ member, onPlay, onNotThis }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const width = isPhone ? 280 : 400;
    const { data: detail } = useQuery(mediaDetailQuery(member.id));
    const { data: cues } = useSpriteCues(detail?.spriteVttUrl ?? null);
    const moments = spread(cues ?? [], MOMENTS);
    const tileWidth = Math.floor((width - 3 * 6) / 4);

    return (
        <Stack gap="xs" w={width}>
            {member.kind === "video" && moments.length > 0 ? (
                <SimpleGrid
                    cols={4}
                    spacing={6}
                    verticalSpacing={6}
                    aria-label="Moments across the video"
                >
                    {moments.map((cue) => (
                        <Tile key={`${cue.url}:${cue.x}:${cue.y}`} cue={cue} width={tileWidth} />
                    ))}
                </SimpleGrid>
            ) : member.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={member.coverUrl}
                    alt=""
                    style={{ width: "100%", borderRadius: 6, display: "block" }}
                />
            ) : (
                <Text size="xs" c="dimmed">
                    No picture yet.
                </Text>
            )}

            <FileName mediaId={member.id} />

            <Text size="xs" c="dimmed">
                {[
                    member.width && member.height ? `${member.width}×${member.height}` : null,
                    member.kind === "video" ? formatDuration(member.durationMs) : null,
                    member.codec,
                ]
                    .filter(Boolean)
                    .join(" · ")}
            </Text>

            <Group gap="xs">
                <Button size="compact-sm" variant="default" onClick={onPlay}>
                    {member.kind === "video" ? "Play it here" : "See it here"}
                </Button>
                {onNotThis && (
                    <Button size="compact-sm" variant="subtle" color="oxblood" onClick={onNotThis}>
                        Not the same as the others
                    </Button>
                )}
            </Group>
        </Stack>
    );
};

export const DupeLook: React.FC<{
    member: DupeMember;
    onPlay: (member: DupeMember) => void;
    /** Keeps this copy apart from the rest of its group (§10i); absent where that cannot be said. */
    onNotThis: ((member: DupeMember) => void) | null;
}> = ({ member, onPlay, onNotThis }) => {
    const [peeking, setPeeking] = useState(false);

    useCloseOnBack(peeking, () => setPeeking(false));

    return (
        <Popover
            opened={peeking}
            onChange={setPeeking}
            position="bottom"
            withArrow
            shadow="md"
            withinPortal
        >
            <Popover.Target>
                <Anchor
                    component="button"
                    type="button"
                    size="xs"
                    c="dimmed"
                    onClick={(event) => {
                        // The row takes a click as "the keyboard is here", not as a choice.
                        event.stopPropagation();
                        setPeeking((open) => !open);
                    }}
                    style={{ minHeight: 44, minWidth: 44 }}
                >
                    Look
                </Anchor>
            </Popover.Target>
            <Popover.Dropdown
                onClick={(event) => {
                    // A tap on the pictures, or anywhere but a control, closes it.
                    if (!(event.target as Element).closest("button, a, input, label")) {
                        setPeeking(false);
                    }
                }}
            >
                <DupePeek
                    member={member}
                    onPlay={() => {
                        setPeeking(false);
                        onPlay(member);
                    }}
                    onNotThis={
                        onNotThis &&
                        (() => {
                            setPeeking(false);
                            onNotThis(member);
                        })
                    }
                />
            </Popover.Dropdown>
        </Popover>
    );
};
