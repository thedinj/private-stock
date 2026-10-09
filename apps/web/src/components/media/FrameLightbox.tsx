"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Box, Button, Group, Image, Modal, Text, TextInput } from "@mantine/core";

import type { MediaFrame } from "@private-stock/core";

import { rememberReturn } from "@/lib/returnTo";
import { formatTimecode } from "@/lib/timecode";
import { isTypingTarget } from "@/lib/typingTarget";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

/**
 * One frame, big enough to look at (§13).
 *
 * Clicking a thumbnail enlarges it. That is what clicking a small picture means everywhere
 * else, and the strip used to spend it on silently re-covering the library — an action with a
 * lasting, library-wide consequence, triggered by the most casual gesture there is and
 * explained only in a tooltip, which is nothing at all on a touchscreen.
 *
 * So the consequential actions live here, with words on them. Enlarging is free, reversible
 * and expected; setting a cover and deleting a still are none of those things.
 */

interface FrameLightboxProps {
    /** The frames to move between, in the order the strip shows them. */
    frames: MediaFrame[];
    /** Which one is open, or null when the lightbox is closed. */
    openId: string | null;
    onClose: () => void;
    onOpenId: (artifactId: string) => void;
    /** Absent where choosing a cover is not on offer, such as the Captures page. */
    onSetCover?: (artifactId: string) => void;
    onDelete: (artifactId: string) => void;
    /** Move the player to where this frame was taken, on the page that has the player. */
    onSeek?: (atMs: number) => void;
    /**
     * Where to go to see this frame's moment, on a page with no player: the item page at
     * `?at=`. Takes precedence over `onSeek` when both are given.
     */
    seekHref?: (frame: MediaFrame) => string;
    /** Write or clear a capture's caption. The field is offered only on frames you may alter. */
    onRename?: (artifactId: string, label: string | null) => void;
    busy: boolean;
}

const atLabel = (atMs: number | null): string | null =>
    atMs === null ? null : formatTimecode(atMs);

/**
 * A capture's caption, edited in place.
 *
 * Commits on Enter or on leaving the field rather than on every keystroke, and only when the
 * text actually changed — each commit is a write and a refetch of two caches. Keyed by the
 * frame by its caller, so stepping to the next frame starts from that frame's caption instead
 * of carrying the draft across.
 */
const CaptionField: React.FC<{
    frame: MediaFrame;
    onRename: (artifactId: string, label: string | null) => void;
}> = ({ frame, onRename }) => {
    const [draft, setDraft] = useState(frame.label ?? "");

    const commit = () => {
        const next = draft.trim();

        if (next !== (frame.label ?? "")) {
            onRename(frame.artifactId, next === "" ? null : next);
        }
    };

    return (
        <TextInput
            aria-label="Caption"
            placeholder="Add a caption"
            description="Seen by everyone who can see this item"
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.currentTarget.blur();
                }
            }}
            w={{ base: "100%", sm: 360 }}
        />
    );
};

export const FrameLightbox: React.FC<FrameLightboxProps> = ({
    frames,
    openId,
    onClose,
    onOpenId,
    onSetCover,
    onDelete,
    onSeek,
    seekHref,
    onRename,
    busy,
}) => {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);

    /**
     * Fitted to the window, or at 1:1 (§13).
     *
     * Fitted by default, because the first thing anybody wants is the whole frame at once. 1:1
     * is for checking the pixels — focus, compression, a face in the background — and a still
     * is usually larger than the window, so it scrolls. Kept while stepping between frames, so
     * the same detail can be compared across several; reset when the view closes.
     */
    const [actualSize, setActualSize] = useState(false);

    useEffect(() => {
        if (openId === null) setActualSize(false);
    }, [openId]);

    /** At 1:1, start at the middle of the frame rather than its top-left corner. */
    const centre = () => {
        const stage = stageRef.current;

        if (!stage || !actualSize) return;

        stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
        stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
    };

    useEffect(centre, [actualSize]);

    /**
     * Dragging to pan, for a mouse.
     *
     * A wheel scrolls one axis, and a mouse has no way to move sideways without a modifier
     * nobody knows about. Touch is left to the browser's own scrolling, which already pans and
     * flings. A drag that moved is not also a tap: it would otherwise end every pan by dropping
     * out of 1:1.
     */
    const drag = useRef<{
        x: number;
        y: number;
        left: number;
        top: number;
        moved: boolean;
    } | null>(null);

    const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
        const stage = stageRef.current;

        if (event.pointerType !== "mouse" || event.button !== 0 || !stage) return;

        drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: stage.scrollLeft,
            top: stage.scrollTop,
            moved: false,
        };
        stage.setPointerCapture(event.pointerId);
    };

    const pan = (event: React.PointerEvent<HTMLDivElement>) => {
        const stage = stageRef.current;
        const start = drag.current;

        if (!stage || !start) return;

        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;

        if (Math.abs(dx) + Math.abs(dy) > 4) start.moved = true;

        stage.scrollLeft = start.left - dx;
        stage.scrollTop = start.top - dy;
    };

    const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
        if (stageRef.current?.hasPointerCapture(event.pointerId)) {
            stageRef.current.releasePointerCapture(event.pointerId);
        }
        // Cleared after the click that follows this pointerup has had a chance to read it.
        setTimeout(() => {
            drag.current = null;
        }, 0);
    };

    const endZoomOnTap = () => {
        if (!drag.current?.moved) setActualSize(false);
    };

    const index = frames.findIndex((frame) => frame.artifactId === openId);
    const frame = index === -1 ? null : frames[index];

    // A phone's Back closes the frame rather than leaving the page behind it.
    useCloseOnBack(frame !== null, onClose);

    const step = (by: number) => {
        const next = frames[index + by];

        if (next) onOpenId(next.artifactId);
    };

    /**
     * The keys this view owns while it is open.
     *
     * The player has stood down by now — it is told not to listen — so arrows move between
     * frames rather than seeking, and `f` escalates to real fullscreen instead of
     * fullscreening the video behind this.
     */
    useEffect(() => {
        if (!frame) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            // The caption field is inside this view: typing "f" into it is a letter, and the
            // arrows move the caret rather than the frame.
            if (isTypingTarget(event.target)) {
                return;
            }

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                step(-1);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                step(1);
            } else if (event.key === "z") {
                event.preventDefault();
                setActualSize((current) => !current);
            } else if (event.key === "f") {
                event.preventDefault();

                if (document.fullscreenElement) void document.exitFullscreen();
                else void surfaceRef.current?.requestFullscreen();
            }
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frame, index, frames]);

    return (
        <Modal
            opened={frame !== null}
            onClose={onClose}
            // Filling the viewport rather than sitting in it: the point of opening a still is
            // to see the pixels, and a 600px dialog around a 2560px image is a smaller view
            // than the strip it came from.
            fullScreen
            withCloseButton
            /**
             * Pinch to zoom, on a phone.
             *
             * The modal locks the page's scrolling, and the lock cancels every two-finger
             * touch move unless told otherwise -- which on a picture you opened to look at
             * closely took away the one gesture a phone has for it. The browser's own zoom
             * rather than one written here: it already pans, flings and snaps back.
             */
            removeScrollProps={{ allowPinchZoom: true }}
            title={
                frame ? (
                    <Group gap="sm">
                        <Text size="sm">
                            {frame.source === "user" ? "Captured frame" : "Generated frame"}
                        </Text>
                        {atLabel(frame.atMs) && (
                            <Text size="sm" c="dimmed">
                                at {atLabel(frame.atMs)}
                            </Text>
                        )}
                        {frame.isCover && (
                            <Badge color="brass" variant="light" size="sm">
                                Cover
                            </Badge>
                        )}
                        {/* Read-only where the field below is not offered: somebody else's
                            capture, or a page that does not edit captions. */}
                        {frame.label && !(onRename && frame.discardable) && (
                            <Text size="sm" fw={500} lineClamp={1}>
                                {frame.label}
                            </Text>
                        )}
                    </Group>
                ) : null
            }
            /**
             * The body is sized to what is left after the header, and never scrolls.
             *
             * Mantine's default body padding plus a full-height child is taller than the
             * space there is, which put a scrollbar down the side of a view whose whole job
             * is to show one picture at once. `minmax(0, 1fr)` inside does the other half:
             * a grid row defaults to `auto`, so an image taller than the row grows the row
             * rather than being contained by it.
             */
            styles={{
                body: {
                    height: "calc(100dvh - var(--mantine-spacing-xl) * 2)",
                    padding: 0,
                    overflow: "hidden",
                },
            }}
        >
            {frame && (
                <Box
                    ref={surfaceRef}
                    style={{
                        height: "100%",
                        display: "grid",
                        gridTemplateRows: "minmax(0, 1fr) auto",
                        background: "#0d0a08",
                    }}
                >
                    {/* The stage. `position: relative` makes it the box a fitted frame is
                        placed in: the grid row above is `minmax(0, 1fr)` and so a definite
                        height, where the image's own `height: 100%` inside a grid cell was
                        not — the cell's row sized itself to the picture, and a 2560px still
                        rendered at 2560px, spilling past the window. */}
                    <Box
                        ref={stageRef}
                        onPointerDown={actualSize ? startPan : undefined}
                        onPointerMove={actualSize ? pan : undefined}
                        onPointerUp={actualSize ? endPan : undefined}
                        onPointerCancel={actualSize ? endPan : undefined}
                        style={{
                            position: "relative",
                            minHeight: 0,
                            display: "flex",
                            overflow: actualSize ? "auto" : "hidden",
                            padding: 12,
                            cursor: actualSize ? "grab" : undefined,
                        }}
                    >
                        {/* `contain` rather than `cover`: this is the one place the whole
                            frame matters, and cropping it to fill a box would hide the part
                            somebody paused for.

                            Mantine's Image rather than `next/image`, like every other picture
                            in the app: these are authenticated artifact URLs carrying their
                            own version token, and routing them through the image optimiser
                            would proxy bytes that are already sized and already cached. */}
                        <Image
                            src={frame.fullUrl}
                            alt=""
                            draggable={false}
                            onLoad={centre}
                            /**
                             * Fitted, it fills the stage and is letterboxed inside it, which is
                             * what enlarging a picture is for: a still smaller than the window —
                             * an old 640px capture, or a low-resolution source — otherwise
                             * renders at its natural size in the middle of a black field.
                             *
                             * A tap on a fitted frame closes it, the way it opened: the picture
                             * is what you tapped to get here, so it is what you reach for to get
                             * back. At 1:1 a tap returns to fitted instead — the picture then
                             * fills the screen and is being panned, and a stray tap that threw
                             * the whole view away would lose your place in it.
                             *
                             * `objectFit` is set here rather than through Mantine's `fit`
                             * prop because a `style` prop replaces Mantine's own: the
                             * shorthand was being dropped, and the frame cropped to fill the
                             * box instead of fitting inside it.
                             */
                            onClick={actualSize ? endZoomOnTap : onClose}
                            style={
                                actualSize
                                    ? {
                                          // `margin: auto` centres a frame smaller than the
                                          // window and, unlike centring the flex line, does
                                          // not push a larger one's left edge out of reach
                                          // of the scrollbar.
                                          margin: "auto",
                                          flexShrink: 0,
                                          width: "auto",
                                          height: "auto",
                                          maxWidth: "none",
                                          maxHeight: "none",
                                          userSelect: "none",
                                      }
                                    : {
                                          position: "absolute",
                                          inset: 12,
                                          width: "calc(100% - 24px)",
                                          height: "calc(100% - 24px)",
                                          objectFit: "contain",
                                          cursor: "zoom-out",
                                      }
                            }
                        />
                    </Box>

                    <Group gap="sm" p="sm" justify="center" wrap="wrap">
                        <Button
                            variant="default"
                            disabled={index <= 0}
                            onClick={() => step(-1)}
                            aria-label="Previous frame"
                        >
                            ‹
                        </Button>
                        <Text size="xs" c="dimmed">
                            {index + 1} of {frames.length}
                        </Text>
                        <Button
                            variant="default"
                            disabled={index >= frames.length - 1}
                            onClick={() => step(1)}
                            aria-label="Next frame"
                        >
                            ›
                        </Button>

                        <Button
                            variant="default"
                            onClick={() => setActualSize((current) => !current)}
                            aria-pressed={actualSize}
                            title="Toggle actual size (z)"
                        >
                            {actualSize ? "Fit to screen" : "Actual size"}
                        </Button>

                        <Box w={16} />

                        {/* Absent, not disabled, when this frame cannot be the cover: a
                            greyed button invites you to work out why, and the answer — its
                            cover-sized rendering was never written — is not something the
                            viewer can act on. */}
                        {onSetCover && frame.coverable && (
                            <Button
                                color="brass"
                                disabled={busy || frame.isCover}
                                onClick={() => onSetCover(frame.artifactId)}
                            >
                                {frame.isCover ? "This is the cover" : "Use as cover"}
                            </Button>
                        )}

                        {/* `atMs` has been stored on every frame since the schema was
                            written, precisely so the player can go back to where a still came
                            from. This is the first thing to use it. */}
                        {frame.atMs !== null && seekHref ? (
                            <Button
                                variant="default"
                                component={Link}
                                href={seekHref(frame)}
                                prefetch={false}
                                // Over the history entry this view pushed for Back to close it
                                // (`useCloseOnBack`), so Back from the video lands on the page
                                // this frame was opened from rather than on that entry.
                                replace
                                onClick={rememberReturn}
                            >
                                Open video at {atLabel(frame.atMs)}
                            </Button>
                        ) : (
                            frame.atMs !== null &&
                            onSeek && (
                                <Button
                                    variant="default"
                                    onClick={() => {
                                        onSeek(frame.atMs!);
                                        onClose();
                                    }}
                                >
                                    Go to {atLabel(frame.atMs)}
                                </Button>
                            )
                        )}

                        {/* Only a capture, and only your own unless you administer the
                            library: the generated frames belong to the generator, and
                            somebody else's capture is not yours to throw away (§6).

                            The same words as the tile's tooltip, deliberately — "discard"
                            rather than "delete" because nothing goes to the trash and there
                            is nothing to restore it from. */}
                        {frame.discardable && (
                            <Button
                                variant="subtle"
                                color="oxblood"
                                disabled={busy}
                                onClick={() => onDelete(frame.artifactId)}
                            >
                                Discard this capture
                            </Button>
                        )}

                        {onRename && frame.discardable && (
                            <CaptionField
                                key={frame.artifactId}
                                frame={frame}
                                onRename={onRename}
                            />
                        )}
                    </Group>
                </Box>
            )}
        </Modal>
    );
};
