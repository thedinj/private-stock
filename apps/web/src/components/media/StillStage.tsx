"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Menu, Text, Tooltip } from "@mantine/core";

import { useIdleControls } from "@/lib/useIdleControls";
import { usePlayerFullscreen } from "@/lib/usePlayerFullscreen";
import { useStillDwell } from "@/lib/useStillDwell";
import { DWELL_CHOICES, type DwellSeconds } from "@/lib/stageDwell";
import { isTypingTarget } from "@/lib/typingTarget";

import { FullscreenGlyph, PauseGlyph, PlayGlyph } from "./Glyph";
import { StillSlots } from "./StillSlots";

import classes from "./StillStage.module.scss";

/**
 * A picture on the stage, and its clock (§14b).
 *
 * The still's answer to `VideoPlayer`, and the reason the viewer can now walk a mixed set: it
 * owns the picture, its transport, its failure, its fullscreen and its own end. **What is on the
 * stage is not the same question as what kind of item this is** — a photograph is a still and so
 * is a video awaiting a rendition, which used to leave the stage empty and a rolling show parked
 * in front of it forever.
 *
 * The page keeps the two things that are its own: which mode the stage is in, and what to do when
 * the picture's time is up. That is the same split the capture button and the clip marks already
 * use.
 *
 * **Two elements, one of them showing** — see `StillSlots`, which holds the pictures and says
 * when the one on show can be painted.
 */

interface StillStageProps {
    /** Which arrival this is. Every latch and clock in here resets on it. */
    mediaId: string;
    /** The picture, or null when there is none to show — a cover that has not been made yet. */
    src: string | null;
    alt: string;
    /** The next picture worth decoding early, and the id it belongs to. */
    preloadMediaId: string | null;
    preloadSrc: string | null;
    /** How long to hold this picture, or null when no show is running. */
    dwellMs: number | null;
    /** Its time is up. The page decides whether that means onward, and whether it counted. */
    onDwellEnded: () => void;
    /** False while something else owns the keyboard, as the enlarged frame view does. */
    hotkeys: boolean;
    /**
     * The hold, and a way to change it, from the bar that is counting it (§14b).
     *
     * Offered here while a show is running because this is the one place that is certainly on
     * screen when a picture's hold matters -- including in full screen, where the page's own
     * Playback menu is out of reach.
     */
    dwellSeconds?: DwellSeconds;
    onDwellSeconds?: (seconds: DwellSeconds) => void;
}

export const StillStage: React.FC<StillStageProps> = ({
    mediaId,
    src,
    alt,
    preloadMediaId,
    preloadSrc,
    dwellMs,
    onDwellEnded,
    hotkeys,
    dwellSeconds,
    onDwellSeconds,
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const {
        isFullscreen,
        toggle: toggleFullscreen,
        attachContainer,
    } = usePlayerFullscreen(containerRef);

    const [failed, setFailed] = useState(false);
    const [aspect, setAspect] = useState<string | null>(null);
    const [pointerOnBar, setPointerOnBar] = useState(false);

    /**
     * A new picture. Both of these are the bug §8b warns about and the page shipped for real:
     * the instance survives a step to the next item, so a failure latched on one photograph
     * claimed every later one was broken too, and a stale aspect would frame the new picture in
     * the old one's box.
     */
    useEffect(() => {
        setFailed(false);
        setAspect(null);
    }, [mediaId]);

    const dwell = useStillDwell({ arrivalKey: mediaId, dwellMs, onEnded: onDwellEnded });
    const { begin } = dwell;

    /** Only the picture on stage may start its clock; `StillSlots` names which it means. */
    const onPaintable = useCallback(
        (id: string) => {
            if (id === mediaId) {
                begin();
            }
        },
        [mediaId, begin]
    );

    const onFailed = useCallback(
        (id: string) => {
            if (id === mediaId) {
                setFailed(true);
            }
        },
        [mediaId]
    );

    /**
     * A picture that cannot be shown at all starts its clock immediately.
     *
     * There is no decode to wait for, and stalling forever on an item whose cover has not been
     * generated is the precise failure this whole mechanism exists to remove.
     */
    useEffect(() => {
        if (src === null || failed) {
            begin();
        }
    }, [src, failed, begin]);

    const controlsIdle = useIdleControls(
        isFullscreen,
        useCallback(() => dwell.paused || pointerOnBar, [dwell.paused, pointerOnBar])
    );

    /**
     * The keys live with the thing that can act on them (§14).
     *
     * `space` and `f` are in the hotkey table and did nothing at all on a photograph, which is
     * how a documented key stops being trusted. Guarded against fields the same way the page and
     * the player guard theirs, and released entirely while the enlarged frame view owns the
     * arrows.
     */
    useEffect(() => {
        if (!hotkeys) {
            return;
        }

        const onKey = (event: KeyboardEvent): void => {
            if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
                return;
            }

            if (event.key === " ") {
                // Only when there is a clock to hold. Otherwise space belongs to the page, where
                // it scrolls.
                if (dwellMs !== null) {
                    event.preventDefault();
                    dwell.toggle();
                }
            } else if (event.key === "f") {
                event.preventDefault();
                toggleFullscreen();
            }
        };

        document.addEventListener("keydown", onKey);

        return () => document.removeEventListener("keydown", onKey);
    }, [hotkeys, dwellMs, dwell, toggleFullscreen]);

    const showEmpty = src === null || failed;

    return (
        <div
            ref={attachContainer}
            className={classes.viewer}
            data-fullscreen={isFullscreen || undefined}
            data-idle={(isFullscreen && controlsIdle) || undefined}
        >
            {/* The pictures are positioned, so they need a box of their own to be positioned in
                — and the bar needs one it is not inside, or it draws across the photograph. */}
            <div
                className={classes.plate}
                style={
                    aspect ? ({ "--ps-still-aspect": aspect } as React.CSSProperties) : undefined
                }
                /*
                 * The picture is its own pause button, exactly as the film is.
                 *
                 * Clicking a video toggles it, and a photograph in a running show is the same
                 * gesture aimed at the same thing — reaching for a small button in the bar to
                 * stop on a picture you want to look at is the friction this removes. On the
                 * plate rather than on the active `<img>` so that the letterboxing beside a
                 * portrait photograph answers too, and so that a still with no picture to show
                 * can still be held.
                 *
                 * Nothing to toggle when no show is running, and then no pointer either: a
                 * cursor promising an action that does not exist is worse than a plain one.
                 */
                data-toggles={dwellMs !== null || undefined}
                onClick={dwellMs !== null ? dwell.toggle : undefined}
            >
                <StillSlots
                    mediaId={mediaId}
                    src={src}
                    alt={alt}
                    preloadMediaId={preloadMediaId}
                    preloadSrc={preloadSrc}
                    onPaintable={onPaintable}
                    onFailed={onFailed}
                    onAspect={setAspect}
                />

                {showEmpty && (
                    <div className={classes.empty}>
                        <Text size="sm" c="dimmed">
                            {src === null
                                ? "There is no picture for this yet."
                                : "This picture could not be displayed. The file may have been moved, or this browser may not read its format."}
                        </Text>
                    </div>
                )}
            </div>

            {/* Always here, for full screen: a photograph with no show running used to have no
                bar at all, so `f` was the only way to give it the screen while a film always
                had a button. The hold and its line appear only while a show runs -- a pause
                button for a clock that is not counting is a lie. */}
            <div
                className={classes.controls}
                data-hidden={controlsIdle || undefined}
                onPointerEnter={() => setPointerOnBar(true)}
                onPointerLeave={() => setPointerOnBar(false)}
            >
                {dwellMs !== null && (
                    <>
                        <Tooltip label={dwell.paused ? "Resume the show" : "Hold here"}>
                            <ActionIcon
                                size="lg"
                                variant="subtle"
                                color="brass"
                                onClick={dwell.toggle}
                                aria-label={dwell.paused ? "Resume the show" : "Hold here"}
                            >
                                {dwell.paused ? <PlayGlyph /> : <PauseGlyph />}
                            </ActionIcon>
                        </Tooltip>

                        <div
                            /*
                             * Remounted per picture and per dwell length, which is what
                             * restarts the sweep. Deliberately *not* per resume: the line
                             * pauses where it is and carries on, because a bar that jumped
                             * back to empty after a hold would be describing a clock nobody
                             * is running.
                             */
                            key={`${mediaId}:${dwellMs}`}
                            className={classes.dwell}
                            data-held={!dwell.running || undefined}
                            style={{ "--ps-dwell": `${dwellMs}ms` } as React.CSSProperties}
                        />

                        {dwellSeconds !== undefined && onDwellSeconds && (
                            <Menu position="top-end" withinPortal>
                                <Menu.Target>
                                    <Button
                                        size="compact-sm"
                                        variant="subtle"
                                        color="gray"
                                        aria-label="How long each picture is held"
                                    >
                                        {dwellSeconds}s
                                    </Button>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    <Menu.Label>Hold each picture</Menu.Label>
                                    {DWELL_CHOICES.map((seconds) => (
                                        <Menu.Item
                                            key={seconds}
                                            onClick={() => onDwellSeconds(seconds)}
                                            c={seconds === dwellSeconds ? "brass.4" : undefined}
                                        >
                                            {seconds} seconds
                                        </Menu.Item>
                                    ))}
                                </Menu.Dropdown>
                            </Menu>
                        )}
                    </>
                )}

                {/* Pushes full screen to the far end when there is no line to do it. */}
                {dwellMs === null && <div style={{ flex: 1 }} />}

                <Tooltip label={isFullscreen ? "Leave full screen (f)" : "Full screen (f)"}>
                    <ActionIcon
                        size="lg"
                        variant="subtle"
                        color="brass"
                        onClick={toggleFullscreen}
                        aria-label={isFullscreen ? "Leave full screen" : "Full screen"}
                    >
                        <FullscreenGlyph />
                    </ActionIcon>
                </Tooltip>
            </div>
        </div>
    );
};
