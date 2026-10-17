"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";

import { cueAt, parseSpriteVtt, type SpriteCue } from "@private-stock/core";

import classes from "./SpriteScrubber.module.scss";

/**
 * The scrubber, with a filmstrip thumbnail under the pointer (§9).
 *
 * The thumbnails come from sprite sheets indexed by a WebVTT track: one cue per interval,
 * each naming a rectangle inside a sheet. Positioning a CSS background from that rectangle is
 * far cheaper than a thumbnail per frame — a two-hour film is three image requests for the
 * whole strip, and they are cached for a year because the URLs carry a version token.
 *
 * The browser's own `<track>` parsing is deliberately not used: a `TextTrackCue` exposes only
 * the cue text as a string, which would have to be parsed for the rectangle anyway.
 */

interface SpriteScrubberProps {
    /** WebVTT thumbnail track, or null while the sprite job has not run yet. */
    vttUrl: string | null;
    durationMs: number;
    positionMs: number;
    bufferedMs: number;
    /**
     * Where to move the playhead, or **absent for a bar that only reports**.
     *
     * Read-only is what a reel's bar is (§14d): it measures the whole reel, so dragging it would
     * have to mean either scrubbing inside the current span — not what a bar spanning the reel
     * appears to offer — or seeking across spans, which is a different feature. Without a handler
     * the track stops being a slider: no role, no tab stop, no pointer capture, no filmstrip. A
     * control that looks draggable and is not is worse than one that does not look draggable.
     */
    onSeek?: (positionMs: number) => void;
    /** Raised while dragging, so the player can stop fighting the scrub with time updates. */
    onScrubbingChange?: (scrubbing: boolean) => void;
    /**
     * Spans already marked on this item, drawn as ticks in a lane under the track (§14d).
     *
     * This viewer's own, because a clip is private raw material. Their point is that you can see
     * what you have already taken while deciding where to cut next — without it the commonest
     * mistake is marking the same moment twice, three weeks apart.
     */
    clips?: { id: string; startMs: number; endMs: number; label: string | null }[];
    /**
     * The span being marked right now, highlighted on the track itself.
     *
     * `endMs` is null between pressing `[` and pressing `]`, which is most of the time somebody
     * is doing this, so the highlight has to be able to draw an in point with no out point yet.
     */
    selection?: { startMs: number; endMs: number | null } | null;
}

const formatTime = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const SpriteScrubber: React.FC<SpriteScrubberProps> = ({
    vttUrl,
    durationMs,
    positionMs,
    bufferedMs,
    onSeek,
    onScrubbingChange,
    clips = [],
    selection = null,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [cues, setCues] = useState<SpriteCue[]>([]);
    const [hoverMs, setHoverMs] = useState<number | null>(null);
    const [scrubbing, setScrubbing] = useState(false);
    /**
     * Where a touch drag is, while the video stays where it was (§9 "Scrubbing a touch drag").
     *
     * Null when no finger is dragging. While it is set it is what the handle and the played bar
     * show, because the element is not being told about the drag until it ends.
     */
    const [dragMs, setDragMs] = useState<number | null>(null);

    /**
     * Fetch and parse the track once.
     *
     * Same-origin `fetch` sends the HttpOnly cookie, which is how the art route authorises a
     * request that cannot carry a Bearer header.
     */
    useEffect(() => {
        if (!vttUrl) {
            setCues([]);
            return;
        }

        const controller = new AbortController();

        void fetch(vttUrl, { signal: controller.signal, credentials: "same-origin" })
            .then((response) => (response.ok ? response.text() : ""))
            .then((text) => setCues(text ? parseSpriteVtt(text) : []))
            .catch(() => {
                // No filmstrip is a degraded scrubber, not a broken one — seeking still works.
            });

        return () => controller.abort();
    }, [vttUrl]);

    const positionFromEvent = useCallback(
        (clientX: number): number => {
            const track = trackRef.current;

            if (!track || durationMs <= 0) {
                return 0;
            }

            const bounds = track.getBoundingClientRect();
            const ratio = (clientX - bounds.left) / bounds.width;

            return Math.min(durationMs, Math.max(0, ratio * durationMs));
        },
        [durationMs]
    );

    const setScrub = useCallback(
        (value: boolean) => {
            setScrubbing(value);
            onScrubbingChange?.(value);
        },
        [onScrubbingChange]
    );

    /**
     * Pointer events rather than mouse and touch separately.
     *
     * `setPointerCapture` is what makes a drag that leaves the bar keep working — without it,
     * dragging below the scrubber silently stops seeking, which feels like the control has
     * broken.
     *
     * **A finger seeks once, when it lifts.** Seeking on every move was 60 to 120 seeks a
     * second on a phone, and each one landing outside what was buffered is a new range
     * request. A mobile browser does not abandon the last one fast enough to keep up, so a
     * long drag left dozens of streams queued against the NAS and the whole session waiting
     * behind them. The filmstrip is what a touch drag shows instead, and the handle follows the
     * finger. A mouse still seeks live -- frame-accurate dragging is how an in point is found --
     * and the player keeps that to one seek in flight at a time (`seekTo` in `VideoPlayer`).
     */
    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!onSeek) {
            return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);

        const next = positionFromEvent(event.clientX);
        setHoverMs(next);
        setScrub(true);

        if (event.pointerType === "mouse") {
            onSeek(next);
        } else {
            setDragMs(next);
        }
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!onSeek) {
            return;
        }

        const next = positionFromEvent(event.clientX);
        setHoverMs(next);

        if (!scrubbing) {
            return;
        }

        if (dragMs === null) {
            onSeek(next);
        } else {
            setDragMs(next);
        }
    };

    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }

        if (dragMs !== null) {
            onSeek?.(dragMs);
            setDragMs(null);
        }

        setScrub(false);
    };

    const previewCue = useMemo(
        () => (hoverMs === null ? null : cueAt(cues, hoverMs)),
        [cues, hoverMs]
    );

    const percent = (ms: number): number =>
        durationMs > 0 ? Math.min(100, Math.max(0, (ms / durationMs) * 100)) : 0;

    // A touch drag shows where the finger is; the playhead catches up when it lifts.
    const shownMs = dragMs ?? positionMs;

    // Keep the thumbnail inside the track rather than letting it hang off either end.
    const previewLeft = hoverMs === null ? 0 : percent(hoverMs);

    return (
        <Box className={classes.wrapper}>
            {previewCue && hoverMs !== null && (
                <Box
                    className={classes.preview}
                    style={{
                        left: `${previewLeft}%`,
                        width: previewCue.width,
                    }}
                >
                    <Box
                        className={classes.thumbnail}
                        style={{
                            width: previewCue.width,
                            height: previewCue.height,
                            backgroundImage: `url(${previewCue.url})`,
                            backgroundPosition: `-${previewCue.x}px -${previewCue.y}px`,
                        }}
                    />
                    <Text size="xs" ta="center" className={classes.previewTime}>
                        {formatTime(hoverMs)}
                    </Text>
                </Box>
            )}

            <Box
                ref={trackRef}
                className={classes.track}
                role={onSeek ? "slider" : "progressbar"}
                tabIndex={onSeek ? 0 : undefined}
                aria-label={onSeek ? "Seek" : "Progress"}
                aria-valuemin={0}
                aria-valuemax={Math.round(durationMs / 1000)}
                aria-valuenow={Math.round(shownMs / 1000)}
                aria-valuetext={formatTime(shownMs)}
                // Absent rather than inert when there is nothing to seek: the cursor and the
                // hover filmstrip both follow from these, and a bar that lights up under the
                // pointer is a bar that claims to be draggable.
                onPointerDown={onSeek ? onPointerDown : undefined}
                onPointerMove={onSeek ? onPointerMove : undefined}
                onPointerUp={onSeek ? onPointerUp : undefined}
                onPointerCancel={onSeek ? onPointerUp : undefined}
                onPointerLeave={() => {
                    if (!scrubbing) {
                        setHoverMs(null);
                    }
                }}
            >
                <Box className={classes.buffered} style={{ width: `${percent(bufferedMs)}%` }} />
                <Box className={classes.played} style={{ width: `${percent(shownMs)}%` }} />
                {/*
                 * The pending selection, over the played bar and under the handle: it is the
                 * thing being decided, so it has to be legible against both.
                 */}
                {selection && (
                    <Box
                        className={classes.selection}
                        style={{
                            left: `${percent(selection.startMs)}%`,
                            width: `${Math.max(0.4, percent((selection.endMs ?? selection.startMs) - selection.startMs))}%`,
                        }}
                    />
                )}
                <Box className={classes.handle} style={{ left: `${percent(shownMs)}%` }} />
            </Box>

            {/*
             * Existing spans, in a lane of their own beneath the track rather than on it.
             *
             * On the track they would compete with the buffered and played bars, which are about
             * where playback is; these are about what has been taken out of the file, which is a
             * different question and deserves its own row. The lane collapses to nothing when
             * there are no clips, so an item nobody has cut looks exactly as it did before.
             */}
            {clips.length > 0 && durationMs > 0 && (
                <Box className={classes.clipLane}>
                    {clips.map((clip) => (
                        <Box
                            key={clip.id}
                            className={classes.clipTick}
                            title={
                                clip.label ??
                                `${formatTime(clip.startMs)}\u2013${formatTime(clip.endMs)}`
                            }
                            style={{
                                left: `${percent(clip.startMs)}%`,
                                width: `${Math.max(0.4, percent(clip.endMs - clip.startMs))}%`,
                            }}
                        />
                    ))}
                </Box>
            )}
        </Box>
    );
};
