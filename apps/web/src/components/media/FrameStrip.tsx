"use client";

import { useState } from "react";
import { ActionIcon, Badge, Box, Group, Image, Stack, Text, Tooltip } from "@mantine/core";

import type { MediaFrame } from "@private-stock/core";

import { FrameLightbox } from "@/components/media/FrameLightbox";
import { useRenameCapture } from "@/lib/api/captures";
import { useDeleteCapture, useSetCover } from "@/lib/api/frames";

import classes from "./FrameStrip.module.scss";

/**
 * The frames that could represent an item, and the ones somebody made (§13).
 *
 * Two groups, at two sizes, and the sizes are the argument. A capture is the frame a person
 * chose out of an hour of video; the generated alternates are five guesses taken at fixed
 * percentages. Drawing them identically, with the guesses first, put your own work at the far
 * right of a strip in a 420px panel — behind five pictures the machine made.
 *
 * Clicking enlarges. The two things that change something — choosing the cover, discarding a
 * capture — are separate buttons that appear on hover or focus, because they are not what a
 * click on a picture promises: one changes what the whole library shows of this item, and the
 * other is not undoable. The enlarged view spells both out in words for anyone who wants them
 * spelled out.
 */

interface FrameStripProps {
    mediaId: string;
    frames: MediaFrame[];
    /** Move the player to where a frame was taken, when there is a player to move. */
    onSeek?: (atMs: number) => void;
    /** Told when the enlarged view opens or closes, so the player can release the keyboard. */
    onLightboxChange?: (open: boolean) => void;
    /** Whether the generated alternates are shown beneath the captures. */
    showGenerated?: boolean;
}

/**
 * "Make this the cover", drawn rather than written.
 *
 * Two stacked cards with the front one brought forward, because that is literally the
 * action: these frames are a pile of pictures of one item and this says which of them the
 * library puts on top. A tick was the first attempt and it only ever meant "yes" — it said
 * nothing about *what* was being agreed to, which on a row of near-identical stills is the
 * whole question. A star and a heart were both out for a different reason: they are the
 * rating and the favourite elsewhere in this app, so either would say something about the
 * item rather than about which picture of it gets shown.
 *
 * The words live in the tooltip and the accessible name — a label wide enough to read
 * covered most of a 104px thumbnail, which left a row of buttons where a row of pictures
 * was supposed to be.
 */
const CoverGlyph: React.FC<{ current: boolean }> = ({ current }) => (
    <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        aria-hidden="true"
    >
        {/* The one behind, peeking out. */}
        <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h9a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 15h-1.5" />
        {/* The one in front: hollow is an offer, filled is a fact. */}
        <rect
            x="3.5"
            y="8.5"
            width="14"
            height="11.5"
            rx="1.5"
            fill={current ? "currentColor" : "none"}
        />
    </svg>
);

/**
 * "Discard this capture", drawn rather than written.
 *
 * A minus in a circle: take this one out of the set. Two other obvious glyphs are both
 * wrong here. A bin is where deleted things *go*, and this app has a real one — trashed
 * media sit in a bounded limbo until they are purged (§10) — whereas a capture is removed
 * outright along with its rendering, so the bin would promise somewhere to get it back from
 * that does not exist. And a bare cross in the corner of a tile is a close button: it reads
 * as dismissing the thing you are looking at, not as destroying it.
 */
const DiscardGlyph = () => (
    <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        aria-hidden="true"
    >
        <circle cx="12" cy="12" r="8.5" />
        <path d="M8.25 12h7.5" />
    </svg>
);

const CAPTURE_TILE = { width: 208, height: 117 };
const GENERATED_TILE = { width: 104, height: 59 };

export const FrameStrip: React.FC<FrameStripProps> = ({
    mediaId,
    frames,
    onSeek,
    onLightboxChange,
    showGenerated = true,
}) => {
    const setCover = useSetCover(mediaId);
    const removeCapture = useDeleteCapture(mediaId);
    const renameCapture = useRenameCapture();

    const [openId, setOpenId] = useState<string | null>(null);

    const busy = setCover.isPending || removeCapture.isPending;

    const captures = frames.filter((frame) => frame.source === "user");
    const generated = frames.filter((frame) => frame.source !== "user");

    const open = (artifactId: string | null) => {
        setOpenId(artifactId);
        onLightboxChange?.(artifactId !== null);
    };

    const tile = (frame: MediaFrame, size: { width: number; height: number }) => (
        <Box key={frame.artifactId} className={classes.tile} style={{ width: size.width }}>
            <Image
                src={frame.url}
                alt=""
                title={frame.label ?? undefined}
                w={size.width}
                h={size.height}
                fit="cover"
                radius="sm"
                onClick={() => open(frame.artifactId)}
                style={{
                    cursor: "zoom-in",
                    outline: frame.isCover
                        ? "2px solid var(--mantine-color-brass-5)"
                        : "1px solid var(--ps-hairline)",
                    outlineOffset: frame.isCover ? 1 : 0,
                    opacity: busy ? 0.6 : 1,
                }}
            />

            {frame.isCover && (
                <Badge
                    color="brass"
                    variant="filled"
                    size="xs"
                    style={{ position: "absolute", top: 4, left: 4, pointerEvents: "none" }}
                >
                    Cover
                </Badge>
            )}

            {/* Both controls in one corner, in a fixed order, so the cover button does not
                move when a tile happens to be a capture. The `Cover` badge holds the
                opposite corner, so nothing collides. */}
            <Group gap={4} className={classes.actions}>
                {/* Always drawn, including on the cover itself — a control that vanishes once
                    it has worked leaves you wondering whether it did. On the cover it is a
                    filled glyph and not a button: there is no such thing as choosing the
                    cover twice, and a live button that does nothing is worse than none. */}
                {/* Not drawn at all when this frame cannot be the cover — a capture whose
                    cover-sized rendering was never written. Drawing it and letting the
                    service refuse is a button that does nothing, which is how the
                    ordinal-0 aliasing stayed invisible for as long as it did. */}
                {frame.coverable && (
                    <Tooltip
                        label={frame.isCover ? "This is the cover" : "Use as cover"}
                        withinPortal
                    >
                        {frame.isCover ? (
                            <Box className={classes.state} aria-label="This is the cover">
                                <CoverGlyph current />
                            </Box>
                        ) : (
                            <ActionIcon
                                size="sm"
                                variant="filled"
                                color="dark"
                                disabled={busy}
                                aria-label="Use as cover"
                                onClick={() => setCover.mutate({ artifactId: frame.artifactId })}
                            >
                                <CoverGlyph current={false} />
                            </ActionIcon>
                        )}
                    </Tooltip>
                )}

                {/* Only a capture, and only your own unless you administer the library. A
                    generated frame is the generator's and deleting one would simply invite
                    it back on the next sweep; somebody else's capture is not yours to throw
                    away, and cannot be regenerated if it goes (§6). */}
                {frame.discardable && (
                    <Tooltip label="Discard this capture" withinPortal>
                        <ActionIcon
                            size="sm"
                            variant="filled"
                            color="dark"
                            disabled={busy}
                            aria-label="Discard this capture"
                            onClick={() => removeCapture.mutate({ artifactId: frame.artifactId })}
                        >
                            <DiscardGlyph />
                        </ActionIcon>
                    </Tooltip>
                )}
            </Group>
        </Box>
    );

    /** A row that scrolls rather than wraps: this lives in a 420px panel as well as a page. */
    const row = (children: React.ReactNode) => (
        <Group gap="xs" wrap="nowrap" style={{ overflowX: "auto", paddingBottom: 4 }}>
            {children}
        </Group>
    );

    return (
        <>
            <Stack gap="md">
                {captures.length > 0 && (
                    <Stack gap={6}>{row(captures.map((frame) => tile(frame, CAPTURE_TILE)))}</Stack>
                )}

                {showGenerated && generated.length > 0 && (
                    <Stack gap={6}>
                        {/* Said only when there are captures to tell them apart from: under the
                            page's own "Frames" label, a lone "Generated" was a second heading
                            for the same row. */}
                        {captures.length > 0 && (
                            <Text size="xs" c="dimmed">
                                Or one of the generated frames
                            </Text>
                        )}
                        {row(generated.map((frame) => tile(frame, GENERATED_TILE)))}
                    </Stack>
                )}

                {captures.length === 0 && generated.length === 0 && (
                    <Text size="sm" c="dimmed">
                        No frames yet — the cover is still being made.
                    </Text>
                )}
            </Stack>

            <FrameLightbox
                // Only what is on screen, so the arrows walk the same set the strip shows.
                frames={showGenerated ? [...captures, ...generated] : captures}
                openId={openId}
                onClose={() => open(null)}
                onOpenId={(artifactId) => setOpenId(artifactId)}
                onSetCover={(artifactId) => setCover.mutate({ artifactId })}
                onDelete={(artifactId) => {
                    removeCapture.mutate({ artifactId });
                    open(null);
                }}
                onSeek={(atMs) => onSeek?.(atMs)}
                // Captioned where it was taken, as well as from the Captures page (§9).
                onRename={(artifactId, label) =>
                    renameCapture.mutate({ mediaId, artifactId, label })
                }
                busy={busy}
            />
        </>
    );
};
