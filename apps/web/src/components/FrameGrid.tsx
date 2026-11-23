"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Group, UnstyledButton } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";

import type { SpriteCue } from "@private-stock/core";

import { useSpriteCues } from "@/lib/api/sprites";
import { formatTimecode } from "@/lib/timecode";

import classes from "./FrameGrid.module.scss";

/**
 * Every frame of the film at once, in rows read like a page (§11, §14).
 *
 * The sprite tiles in time order, as many across as fit: four on a phone, more as the room
 * widens. The frame at `positionMs` is outlined, what has played is faded and underlined in brass, a clip marks its
 * frames with a bar and a capture its frame with a dot. A tap hands the frame's moment to
 * `onPick`; what that does -- send a TV there, seek the picture here -- is the caller's.
 *
 * It scrolls with whatever it sits in: the page while casting, a panel beside the picture
 * otherwise. `revealRef` is how the caller brings the current frame into view.
 */

export interface FrameGridProps {
    vttUrl: string;
    positionMs: number;
    clips: { id: string; startMs: number; endMs: number }[];
    /** Where somebody captured a still. */
    captures: number[];
    onPick: (ms: number) => void;
    /** Centre the current frame once the grid has a size: a panel opened on purpose to look. */
    revealOnMount?: boolean;
    /** Filled with a function that scrolls the current frame into view. */
    revealRef?: React.MutableRefObject<(() => void) | null>;
    /** On the current frame, and in the legend: where it is playing, "TV" while casting. */
    nowBadge?: string;
    nowLegend?: string;
    /** The narrowest a frame is drawn, which sets how many go across. */
    minTilePx?: number;
}

const GAP = 4;

/** The narrowest a frame is drawn: three across a phone, more as the room widens. */
const MIN_TILE_PX = 100;
const MIN_TILE_WIDE_PX = 160;
const WIDE_PX = 720;

const cueKey = (cue: SpriteCue) => `${cue.url}:${cue.x}:${cue.y}`;

/** The nearest ancestor that scrolls, or null for the page itself. */
const scrollParent = (element: HTMLElement): HTMLElement | null => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const { overflowY } = getComputedStyle(parent);

        if (/(auto|scroll)/.test(overflowY) && parent.scrollHeight > parent.clientHeight) {
            return parent;
        }
    }

    return null;
};

/**
 * Centre a frame in whatever it scrolls in -- and only that. `scrollIntoView` moves every
 * scrolling ancestor, so a panel opened over the page scrolled the page under it as well.
 */
const centre = (tile: HTMLElement, behavior: ScrollBehavior) => {
    const parent = scrollParent(tile);
    const rect = tile.getBoundingClientRect();

    if (parent) {
        const box = parent.getBoundingClientRect();

        parent.scrollTo({
            top: parent.scrollTop + rect.top - box.top - (box.height - rect.height) / 2,
            behavior,
        });
    } else {
        window.scrollTo({
            top: window.scrollY + rect.top - (window.innerHeight - rect.height) / 2,
            behavior,
        });
    }
};

/** One sprite tile, cropped from its sheet and drawn `width` pixels wide. */
const Frame: React.FC<{ cue: SpriteCue; width: number }> = ({ cue, width }) => (
    <Box
        w={cue.width}
        h={cue.height}
        className={classes.crop}
        style={{
            backgroundImage: `url(${cue.url})`,
            backgroundPosition: `-${cue.x}px -${cue.y}px`,
            transform: `scale(${width / cue.width})`,
        }}
    />
);

const Grid: React.FC<Omit<FrameGridProps, "vttUrl"> & { cues: SpriteCue[] }> = ({
    cues,
    positionMs,
    clips,
    captures,
    onPick,
    revealOnMount = false,
    revealRef,
    nowBadge = "Now",
    nowLegend = "playing now",
    minTilePx,
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
    const minTile = minTilePx ?? (gridWidth >= WIDE_PX ? MIN_TILE_WIDE_PX : MIN_TILE_PX);
    const columns = Math.max(1, Math.floor((gridWidth + GAP) / (minTile + GAP)));
    const tileWidth = gridWidth > 0 ? (gridWidth - GAP * (columns - 1)) / columns : minTile;
    const tileHeight = (tileWidth * cues[0].height) / cues[0].width;

    const nowIndex = useMemo(() => {
        let found = 0;

        for (let index = 0; index < tiles.length; index++) {
            if (tiles[index].cue.startMs <= positionMs) found = index;
            else break;
        }

        return found;
    }, [tiles, positionMs]);

    const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const nowRef = useRef(nowIndex);
    nowRef.current = nowIndex;

    useEffect(() => {
        if (!revealRef) return;

        revealRef.current = () => {
            const tile = tileRefs.current[nowRef.current];

            if (tile) centre(tile, "smooth");
        };

        return () => {
            revealRef.current = null;
        };
    }, [revealRef]);

    // Once, when the frames first have a size: before that every tile is in the same place.
    const revealed = useRef(false);

    useEffect(() => {
        if (!revealOnMount || revealed.current || gridWidth <= 0) return;

        revealed.current = true;

        const tile = tileRefs.current[nowRef.current];

        if (tile) centre(tile, "instant");
    }, [revealOnMount, gridWidth]);

    /* ── keys: one tab stop, arrows move through the grid ── */
    const [focusIndex, setFocusIndex] = useState<number | null>(null);
    const tabIndexAt = focusIndex ?? nowIndex;

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        // The player's own keys -- space plays, arrows seek -- are not for a press made here.
        if (event.key === " " || event.key === "Enter") {
            event.stopPropagation();

            return;
        }

        const moves: Record<string, number> = {
            ArrowRight: 1,
            ArrowLeft: -1,
            ArrowDown: columns,
            ArrowUp: -columns,
        };
        const move = moves[event.key];

        if (move === undefined) return;

        event.preventDefault();
        event.stopPropagation();

        const next = Math.min(Math.max(tabIndexAt + move, 0), tiles.length - 1);

        setFocusIndex(next);
        tileRefs.current[next]?.focus();
    };

    return (
        <Box className={classes.wrap}>
            <div
                ref={gridRef}
                className={classes.grid}
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP }}
                onKeyDown={onKeyDown}
                role="group"
                aria-label="The film's frames"
            >
                {tiles.map(({ cue, endMs, clip, capture }, index) => (
                    <UnstyledButton
                        key={cueKey(cue)}
                        ref={(element: HTMLButtonElement | null) => {
                            tileRefs.current[index] = element;
                        }}
                        className={classes.tile}
                        h={tileHeight}
                        data-played={endMs <= positionMs || undefined}
                        data-now={index === nowIndex ? nowBadge : undefined}
                        data-clip={clip || undefined}
                        tabIndex={index === tabIndexAt ? 0 : -1}
                        onFocus={() => setFocusIndex(index)}
                        onClick={() => onPick(cue.startMs)}
                        aria-label={`Go to ${formatTimecode(cue.startMs)}`}
                        aria-current={index === nowIndex ? "time" : undefined}
                    >
                        <Frame cue={cue} width={tileWidth} />
                        {(endMs <= positionMs || index === nowIndex) && (
                            <span
                                className={classes.played}
                                style={
                                    {
                                        "--played": playedFraction(cue.startMs, endMs, positionMs),
                                    } as React.CSSProperties
                                }
                            />
                        )}
                        <span className={classes.time}>
                            {formatTimecode(cue.startMs)}
                            {capture && <i className={classes.capture} aria-hidden />}
                        </span>
                    </UnstyledButton>
                ))}
            </div>

            <Group gap="md" justify="center" className={classes.legend} aria-hidden>
                <span>
                    <i className={classes.legendNow} />
                    {nowLegend}
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
                <span>
                    <i className={classes.legendPlayed} />
                    played
                </span>
            </Group>
        </Box>
    );
};

/** How much of a frame's span is behind the playhead, 0 to 1. */
const playedFraction = (startMs: number, endMs: number, positionMs: number): number =>
    endMs > startMs ? Math.min(Math.max((positionMs - startMs) / (endMs - startMs), 0), 1) : 1;

/** Null until the film has a sprite track. */
export const FrameGrid: React.FC<FrameGridProps> = ({ vttUrl, ...rest }) => {
    const { data: cues } = useSpriteCues(vttUrl);

    return cues && cues.length > 0 ? <Grid cues={cues} {...rest} /> : null;
};
