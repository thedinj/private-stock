"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Text, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { SpriteCue } from "@private-stock/core";

import { useSpriteCues } from "@/lib/api/sprites";
import { formatTimecode } from "@/lib/timecode";

import classes from "./CastRibbon.module.scss";

/**
 * The film as a strip of frames under a fixed needle, while it plays on a TV (§11).
 *
 * Casting frees the box the picture stood in, and a picture-shaped cover saying "Playing on the
 * TV" spent it on nothing. This spends it on where to go: the sprite tiles in time order, the
 * moment the TV is at under the needle, the item's clips and captures riding above. Drag the
 * strip and the clock shows where it would land; let go and the TV is sent there **once** -- a
 * Cast seek takes about a second, and streaming them while dragging would leave the TV a step
 * behind every finger. A tap on a frame or a mark goes straight there.
 *
 * Follows the TV while nobody is steering, and holds a sent position until the TV reports it,
 * so the strip does not snap back to where the TV was before it had answered.
 */

interface CastRibbonProps {
    vttUrl: string;
    positionMs: number;
    durationMs: number;
    clips: { id: string; startMs: number; endMs: number }[];
    /** Where somebody captured a still: pins above the strip. */
    captures: number[];
    onSeek: (ms: number) => void;
}

/** Between frames. */
const GAP = 2;

/** No scroll for this long, with no finger down, is a strip that has come to rest. */
const SETTLE_MS = 220;

/** A sent position is held until the TV reports one this close to it, or for this long. */
const ARRIVED_WITHIN_MS = 3_000;
const HOLD_SENT_MS = 5_000;

/** A pointer that moves less than this is a tap, not a drag. */
const TAP_SLOP_PX = 6;

const cueKey = (cue: SpriteCue) => `${cue.url}:${cue.x}:${cue.y}`;

/** One sprite tile, cropped from its sheet and drawn at `height` pixels tall. */
const Frame: React.FC<{ cue: SpriteCue; width: number; height: number; played: boolean }> = ({
    cue,
    width,
    height,
    played,
}) => {
    const scale = height / cue.height;

    return (
        <Box className={classes.frame} w={width} h={height} data-played={played || undefined}>
            <Box
                w={cue.width}
                h={cue.height}
                style={{
                    backgroundImage: `url(${cue.url})`,
                    backgroundPosition: `-${cue.x}px -${cue.y}px`,
                    transform: `scale(${scale})`,
                }}
                className={classes.crop}
            />
        </Box>
    );
};

/** The ribbon itself, once there are cues to draw it from. */
const Ribbon: React.FC<Omit<CastRibbonProps, "vttUrl"> & { cues: SpriteCue[] }> = ({
    cues,
    positionMs,
    durationMs,
    clips,
    captures,
    onSeek,
}) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const height = isPhone ? 84 : 112;
    const first = cues[0];
    const width = Math.round((height * first.width) / first.height);
    const step = width + GAP;
    const span = cues.length * step - GAP;
    // The strip's own length of time: the TV's duration can arrive late, or not at all.
    const totalMs = Math.max(cues[cues.length - 1].endMs, 1);

    const xOf = useCallback(
        (ms: number) => (Math.min(Math.max(ms, 0), totalMs) / totalMs) * span,
        [span, totalMs]
    );
    const msOf = useCallback(
        (x: number) => Math.round((Math.min(Math.max(x, 0), span) / span) * totalMs),
        [span, totalMs]
    );

    const scroller = useRef<HTMLDivElement>(null);
    /** The scroll position this component last set, so its own scrolls are not read as steering. */
    const setLeft = useRef<number | null>(null);
    const touching = useRef(false);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
    /** A tap after a drag is the end of the drag, not a tap on the frame under it. */
    const swallowClick = useRef(false);
    /** Where the strip is being steered to, shown on the clock; null while it follows the TV. */
    const [steering, setSteering] = useState<number | null>(null);
    const [sent, setSent] = useState<{ ms: number; at: number } | null>(null);

    /** The strip was moved by a person since it was last sent -- not merely touched. */
    const steered = useRef(false);

    const send = useCallback(
        (ms: number) => {
            steered.current = false;
            setSteering(null);
            setSent({ ms, at: Date.now() });
            onSeek(ms);
        },
        [onSeek]
    );

    // A sent position stands until the TV has caught up with it, or has had long enough to.
    const holding =
        sent !== null &&
        Math.abs(positionMs - sent.ms) > ARRIVED_WITHIN_MS &&
        Date.now() - sent.at < HOLD_SENT_MS;

    useEffect(() => {
        if (sent && !holding) setSent(null);
    }, [sent, holding]);

    const shownMs = steering ?? (holding && sent ? sent.ms : positionMs);

    // Follow the TV, or the position just sent, whenever nobody has the strip.
    useLayoutEffect(() => {
        const element = scroller.current;

        if (!element || steering !== null || touching.current || drag.current) return;

        const left = xOf(shownMs);

        setLeft.current = left;
        element.scrollLeft = left;
    }, [shownMs, steering, xOf]);

    const settle = useCallback(() => {
        if (settleTimer.current) clearTimeout(settleTimer.current);

        settleTimer.current = setTimeout(() => {
            const element = scroller.current;

            // A tap that moved nothing sends nothing: the frame it landed on does that.
            if (!element || touching.current || drag.current || !steered.current) return;

            send(msOf(element.scrollLeft));
        }, SETTLE_MS);
    }, [msOf, send]);

    useEffect(
        () => () => {
            if (settleTimer.current) clearTimeout(settleTimer.current);
        },
        []
    );

    const onScroll = () => {
        const element = scroller.current;

        if (!element) return;

        // Its own scroll, following the TV: not a person steering.
        // Two pixels: the browser rounds what it is given.
        if (setLeft.current !== null && Math.abs(element.scrollLeft - setLeft.current) < 2) return;

        setLeft.current = null;
        steered.current = true;
        setSteering(msOf(element.scrollLeft));
        settle();
    };

    // A mouse wheel turns the strip. Bound natively: React's wheel listener is passive, and the
    // page must not scroll down as well.
    useEffect(() => {
        const element = scroller.current;

        if (!element) return;

        const onWheel = (event: WheelEvent) => {
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

            event.preventDefault();
            element.scrollLeft += event.deltaY;
        };

        element.addEventListener("wheel", onWheel, { passive: false });

        return () => element.removeEventListener("wheel", onWheel);
    }, []);

    // A mouse drags the strip as a finger does; touch has the browser's own scrolling, momentum
    // included.
    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        // A drag captures the pointer, so its own click lands on the strip and never reaches a
        // frame to clear this: it is cleared by the next press instead.
        swallowClick.current = false;

        if (event.pointerType !== "mouse" || event.button !== 0 || !scroller.current) return;

        drag.current = { x: event.clientX, left: scroller.current.scrollLeft, moved: false };
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        const element = scroller.current;

        if (!current || !element) return;

        const dx = event.clientX - current.x;

        if (!current.moved && Math.abs(dx) < TAP_SLOP_PX) return;

        if (!current.moved) {
            current.moved = true;
            element.setPointerCapture(event.pointerId);
        }

        element.scrollLeft = current.left - dx;
    };

    const onPointerUp = () => {
        const current = drag.current;

        drag.current = null;

        if (current?.moved) {
            swallowClick.current = true;
            settle();
        }
    };

    const jump = (ms: number) => {
        if (swallowClick.current) {
            swallowClick.current = false;

            return;
        }

        send(ms);
    };

    return (
        <Box className={classes.ribbon}>
            <Text
                className={classes.clock}
                data-steering={steering !== null || undefined}
                aria-live="off"
            >
                {formatTimecode(shownMs)}
                <Text span className={classes.total}>
                    {" / "}
                    {formatTimecode(durationMs > 0 ? durationMs : totalMs)}
                </Text>
            </Text>

            <Box className={classes.box}>
                <div
                    ref={scroller}
                    className={classes.scroller}
                    // The cover around this plays and pauses on a click; the strip is for moving.
                    data-cast-strip
                    onScroll={onScroll}
                    onTouchStart={() => {
                        touching.current = true;
                    }}
                    onTouchEnd={() => {
                        touching.current = false;
                        // The strip may still be coasting; it is sent when it stops.
                        settle();
                    }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    // The bar's scrubber below is the slider, keys included; this is the
                    // same thing to the eye and the finger.
                    role="group"
                    aria-label="The film's frames: drag, or tap one, to move the TV there"
                >
                    <div className={classes.track} style={{ width: span }}>
                        <div className={classes.lane}>
                            {clips.map((clip) => (
                                <UnstyledButton
                                    key={clip.id}
                                    className={classes.clip}
                                    style={{
                                        left: xOf(clip.startMs),
                                        width: Math.max(xOf(clip.endMs) - xOf(clip.startMs), 4),
                                    }}
                                    onClick={() => jump(clip.startMs)}
                                    aria-label={`Clip at ${formatTimecode(clip.startMs)}`}
                                />
                            ))}
                            {captures.map((atMs) => (
                                <UnstyledButton
                                    key={atMs}
                                    className={classes.pin}
                                    style={{ left: xOf(atMs) }}
                                    onClick={() => jump(atMs)}
                                    aria-label={`Capture at ${formatTimecode(atMs)}`}
                                />
                            ))}
                        </div>
                        <div className={classes.frames} style={{ gap: GAP }}>
                            {cues.map((cue) => (
                                <UnstyledButton
                                    key={cueKey(cue)}
                                    onClick={() => jump(cue.startMs)}
                                    aria-label={`Go to ${formatTimecode(cue.startMs)}`}
                                    tabIndex={-1}
                                >
                                    <Frame
                                        cue={cue}
                                        width={width}
                                        height={height}
                                        played={cue.endMs <= shownMs}
                                    />
                                </UnstyledButton>
                            ))}
                        </div>
                    </div>
                </div>
                <div className={classes.needle} aria-hidden />
            </Box>
        </Box>
    );
};

/** Null until the film has a sprite track, and the cover stands in as before. */
export const CastRibbon: React.FC<CastRibbonProps> = ({ vttUrl, ...rest }) => {
    const { data: cues } = useSpriteCues(vttUrl);

    return cues && cues.length > 0 ? <Ribbon cues={cues} {...rest} /> : null;
};
