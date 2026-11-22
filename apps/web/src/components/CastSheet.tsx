"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";

import type { SpriteCue } from "@private-stock/core";

import { useSpriteCues } from "@/lib/api/sprites";
import { formatTimecode } from "@/lib/timecode";

import classes from "./CastSheet.module.scss";

/**
 * The film as a contact sheet, while it plays on a TV (§11).
 *
 * Every sprite tile at once, in rows read like a page, under the remote. Looking is scrolling up
 * and down and never moves the TV; one tap on a frame sends it there, once, and Undo puts it
 * back. It replaced a strip of frames under a needle that was dragged to steer: a phone showed
 * three frames of it, and every look along the film moved the TV.
 *
 * The sheet keeps the frame the TV is on in view while it plays, until somebody scrolls it;
 * then it stays where they left it, with a way back. A sent position is held until the TV
 * reports it, so the outline does not jump back to where the TV was before it had answered.
 */

interface CastSheetProps {
    vttUrl: string;
    positionMs: number;
    clips: { id: string; startMs: number; endMs: number }[];
    /** Where somebody captured a still: a dot on the frame it falls in. */
    captures: number[];
    onSeek: (ms: number) => void;
}

const GAP = 4;

/** The narrowest a frame is drawn: four across a phone, more as the screen widens. */
const MIN_TILE_PX = 76;
const MIN_TILE_WIDE_PX = 136;
const WIDE_PX = 720;

/** A sent position is held until the TV reports one this close to it, or for this long. */
const ARRIVED_WITHIN_MS = 3_000;
const HOLD_SENT_MS = 5_000;

/** How long Undo is offered. */
const UNDO_MS = 6_000;

const cueKey = (cue: SpriteCue) => `${cue.url}:${cue.x}:${cue.y}`;

/** One sprite tile, cropped from its sheet and drawn `width` pixels wide. */
const Frame: React.FC<{ cue: SpriteCue; width: number }> = ({ cue, width }) => {
    const scale = width / cue.width;

    return (
        <Box
            w={cue.width}
            h={cue.height}
            className={classes.crop}
            style={{
                backgroundImage: `url(${cue.url})`,
                backgroundPosition: `-${cue.x}px -${cue.y}px`,
                transform: `scale(${scale})`,
            }}
        />
    );
};

const Sheet: React.FC<Omit<CastSheetProps, "vttUrl"> & { cues: SpriteCue[] }> = ({
    cues,
    positionMs,
    clips,
    captures,
    onSeek,
}) => {
    const totalMs = Math.max(cues[cues.length - 1].endMs, 1);
    const tiles = useMemo(
        () =>
            cues.map((cue, index) => {
                const endMs = index + 1 < cues.length ? cues[index + 1].startMs : totalMs;

                return {
                    cue,
                    endMs,
                    clip: clips.some((clip) => clip.startMs < endMs && clip.endMs > cue.startMs),
                    capture: captures.some((atMs) => atMs >= cue.startMs && atMs < endMs),
                };
            }),
        [cues, clips, captures, totalMs]
    );

    const { ref: gridRef, width: gridWidth } = useElementSize();
    const minTile = gridWidth >= WIDE_PX ? MIN_TILE_WIDE_PX : MIN_TILE_PX;
    const columns = Math.max(1, Math.floor((gridWidth + GAP) / (minTile + GAP)));
    const tileWidth = gridWidth > 0 ? (gridWidth - GAP * (columns - 1)) / columns : minTile;
    const tileHeight = (tileWidth * cues[0].height) / cues[0].width;

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
    const nowIndex = useMemo(() => {
        let found = 0;

        for (let index = 0; index < tiles.length; index++) {
            if (tiles[index].cue.startMs <= shownMs) found = index;
            else break;
        }

        return found;
    }, [tiles, shownMs]);

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

    /* ── following the TV ── */
    const scroller = useRef<HTMLDivElement>(null);
    const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
    /** The scroll position this component last set, so its own scrolls are not read as a person's. */
    const setTop = useRef<number | null>(null);
    const [follow, setFollow] = useState(true);

    const reveal = useCallback((index: number, always: boolean) => {
        const element = scroller.current;
        const tile = tileRefs.current[index];

        if (!element || !tile) return;

        // The scroller is the tiles' offset parent, so this is their place in its content.
        const top = tile.offsetTop;
        const visible =
            top >= element.scrollTop &&
            top + tile.offsetHeight <= element.scrollTop + element.clientHeight;

        if (visible && !always) return;

        const target = Math.round(
            Math.min(
                Math.max(top - element.clientHeight / 2 + tile.offsetHeight / 2, 0),
                element.scrollHeight - element.clientHeight
            )
        );

        if (Math.abs(target - element.scrollTop) < 1) return;

        setTop.current = target;
        element.scrollTop = target;
    }, []);

    // Centred once the frames have a size, then kept in view as the TV moves on.
    const placed = useRef(false);

    useLayoutEffect(() => {
        if (gridWidth <= 0 || !follow) return;

        reveal(nowIndex, !placed.current);
        placed.current = true;
    }, [nowIndex, follow, gridWidth, reveal]);

    const onScroll = () => {
        const element = scroller.current;

        if (!element) return;

        // Its own scroll, following the TV. Two pixels: the browser rounds what it is given.
        if (setTop.current !== null && Math.abs(element.scrollTop - setTop.current) < 2) return;

        setTop.current = null;
        setFollow(false);
    };

    const backToNow = () => {
        setFollow(true);
        reveal(nowIndex, true);
    };

    const jump = (ms: number) => {
        setUndo({ to: ms, from: shownMs });
        setFollow(true);
        send(ms);
    };

    /* ── keys: one tab stop, arrows move through the sheet ── */
    const [focusIndex, setFocusIndex] = useState<number | null>(null);
    const tabIndexAt = focusIndex ?? nowIndex;

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const moves: Record<string, number> = {
            ArrowRight: 1,
            ArrowLeft: -1,
            ArrowDown: columns,
            ArrowUp: -columns,
        };
        const move = moves[event.key];

        if (move === undefined) return;

        event.preventDefault();

        const next = Math.min(Math.max(tabIndexAt + move, 0), tiles.length - 1);

        setFocusIndex(next);
        tileRefs.current[next]?.focus();
    };

    return (
        <Box className={classes.sheet} data-cast-sheet>
            <Text className={classes.hint}>Tap a frame to send the TV there.</Text>

            <Box className={classes.frame}>
                <div
                    ref={scroller}
                    className={classes.scroller}
                    onScroll={onScroll}
                    onKeyDown={onKeyDown}
                    role="group"
                    aria-label="The film's frames: tap one to move the TV there"
                >
                    <div
                        ref={gridRef}
                        className={classes.grid}
                        style={{
                            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                            gap: GAP,
                        }}
                    >
                        {tiles.map(({ cue, endMs, clip, capture }, index) => (
                            <UnstyledButton
                                key={cueKey(cue)}
                                ref={(element: HTMLButtonElement | null) => {
                                    tileRefs.current[index] = element;
                                }}
                                className={classes.tile}
                                h={tileHeight}
                                data-played={endMs <= shownMs || undefined}
                                data-now={index === nowIndex || undefined}
                                data-clip={clip || undefined}
                                tabIndex={index === tabIndexAt ? 0 : -1}
                                onFocus={() => setFocusIndex(index)}
                                onClick={() => jump(cue.startMs)}
                                aria-label={`Send the TV to ${formatTimecode(cue.startMs)}`}
                                aria-current={index === nowIndex ? "time" : undefined}
                            >
                                <Frame cue={cue} width={tileWidth} />
                                <span className={classes.time}>
                                    {formatTimecode(cue.startMs)}
                                    {capture && <i className={classes.capture} aria-hidden />}
                                </span>
                            </UnstyledButton>
                        ))}
                    </div>
                </div>

                {!follow && (
                    <UnstyledButton className={classes.backToNow} onClick={backToNow}>
                        Back to now
                    </UnstyledButton>
                )}

                {undo && (
                    <Group className={classes.toast} gap="xs" wrap="nowrap" role="status">
                        <Text size="sm" fw={600} className={classes.toastText}>
                            Sent the TV to {formatTimecode(undo.to)}
                        </Text>
                        <UnstyledButton
                            className={classes.undo}
                            onClick={() => {
                                setUndo(null);
                                setFollow(true);
                                send(undo.from);
                            }}
                        >
                            Undo
                        </UnstyledButton>
                    </Group>
                )}
            </Box>

            <Group gap="md" justify="center" className={classes.legend} aria-hidden>
                <span>
                    <i className={classes.legendNow} />
                    on the TV now
                </span>
                {clips.length > 0 && (
                    <span>
                        <i className={classes.legendClip} />
                        clip
                    </span>
                )}
                {captures.length > 0 && (
                    <span>
                        <i className={classes.legendCapture} />
                        capture
                    </span>
                )}
                <span>dimmed: played</span>
            </Group>
        </Box>
    );
};

/** Null until the film has a sprite track. */
export const CastSheet: React.FC<CastSheetProps> = ({ vttUrl, ...rest }) => {
    const { data: cues } = useSpriteCues(vttUrl);

    return cues && cues.length > 0 ? <Sheet cues={cues} {...rest} /> : null;
};
