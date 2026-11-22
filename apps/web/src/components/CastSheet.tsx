"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Group, Text, UnstyledButton } from "@mantine/core";

import { formatTimecode } from "@/lib/timecode";

import { FrameGrid } from "./FrameGrid";

import classes from "./CastSheet.module.scss";

/**
 * The film as a contact sheet, while it plays on a TV (§11).
 *
 * Every frame at once (`FrameGrid`), in the page above the remote docked at the screen's foot.
 * Looking is scrolling the page, and never moves the TV; one tap on a frame sends it there,
 * once, and Undo puts it back. It replaced a strip of frames under a needle that was dragged to
 * steer: a phone showed three frames of it, and every look along the film moved the TV. It
 * scrolled in a box of its own at first, under the remote; on a phone a swipe then reached
 * either the box or the page, never both, and the box ran under the foot of the screen.
 *
 * Nothing scrolls by itself: the page is the reader's. The dock's TV button brings the TV's
 * frame into view (`revealRef`). A sent position is held until the TV reports it, so the
 * outline does not jump back to where the TV was before it had answered.
 */

interface CastSheetProps {
    vttUrl: string;
    positionMs: number;
    clips: { id: string; startMs: number; endMs: number }[];
    captures: number[];
    onSeek: (ms: number) => void;
    revealRef: React.MutableRefObject<(() => void) | null>;
}

/** A sent position is held until the TV reports one this close to it, or for this long. */
const ARRIVED_WITHIN_MS = 3_000;
const HOLD_SENT_MS = 5_000;

/** How long Undo is offered. */
const UNDO_MS = 6_000;

export const CastSheet: React.FC<CastSheetProps> = ({
    vttUrl,
    positionMs,
    clips,
    captures,
    onSeek,
    revealRef,
}) => {
    const [sent, setSent] = useState<{ ms: number; at: number } | null>(null);
    const [undo, setUndo] = useState<{ to: number; from: number } | null>(null);

    const holding =
        sent !== null &&
        Math.abs(positionMs - sent.ms) > ARRIVED_WITHIN_MS &&
        Date.now() - sent.at < HOLD_SENT_MS;

    useEffect(() => {
        if (sent && !holding) setSent(null);
    }, [sent, holding]);

    const shownMs = holding && sent ? sent.ms : positionMs;

    const send = useCallback(
        (ms: number) => {
            setSent({ ms, at: Date.now() });
            onSeek(ms);
        },
        [onSeek]
    );

    useEffect(() => {
        if (!undo) return;

        const timer = setTimeout(() => setUndo(null), UNDO_MS);

        return () => clearTimeout(timer);
    }, [undo]);

    return (
        <Box className={classes.sheet} data-cast-sheet>
            <Box className={classes.scroll}>
                <Text className={classes.hint}>Tap a frame to send the TV there.</Text>
                <FrameGrid
                    vttUrl={vttUrl}
                    positionMs={shownMs}
                    clips={clips}
                    captures={captures}
                    onPick={(ms) => {
                        setUndo({ to: ms, from: shownMs });
                        send(ms);
                    }}
                    revealRef={revealRef}
                    nowBadge="TV"
                    nowLegend="on the TV now"
                />
            </Box>

            {undo && (
                <Group className={classes.toast} gap="xs" wrap="nowrap" role="status">
                    <Text size="sm" fw={600} className={classes.toastText}>
                        Sent the TV to {formatTimecode(undo.to)}
                    </Text>
                    <UnstyledButton
                        className={classes.undo}
                        onClick={() => {
                            setUndo(null);
                            send(undo.from);
                        }}
                    >
                        Undo
                    </UnstyledButton>
                </Group>
            )}
        </Box>
    );
};
