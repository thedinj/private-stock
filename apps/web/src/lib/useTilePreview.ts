"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PREVIEW_PRIORITY_GALLERY, PREVIEW_PRIORITY_HOVER } from "./previewBudget";
import { usePreviewSlot } from "./usePreviewSlot";

/**
 * A tile's preview clip: whether it may play, and the element that plays it (§9, §14).
 *
 * Shared by the library grid and the showcase, which disagree about when a tile *wants* to
 * play and must agree about everything after that — the budget, starting and stopping, and
 * giving the decoder back.
 */

/**
 * Delay before a hover starts a preview.
 *
 * Without it, dragging the pointer across the grid starts and cancels a video on every tile
 * it crosses — which is both visually frantic and a burst of range requests for files nobody
 * is looking at.
 */
const HOVER_INTENT_MS = 350;

export const useHoverIntent = (): {
    hovered: boolean;
    onEnter: () => void;
    onLeave: () => void;
} => {
    const [hovered, setHovered] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) {
                clearTimeout(timer.current);
            }
        },
        []
    );

    const onEnter = useCallback(() => {
        if (timer.current) {
            clearTimeout(timer.current);
        }

        timer.current = setTimeout(() => setHovered(true), HOVER_INTENT_MS);
    }, []);

    const onLeave = useCallback(() => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }

        setHovered(false);
    }, []);

    return { hovered, onEnter, onLeave };
};

export const useTilePreview = (
    previewUrl: string | null,
    hovered: boolean,
    autoplay: boolean
): {
    /** Render the `<video>` only while this is true: its existence is what holds a decoder. */
    mayPlay: boolean;
    /** Frames are arriving. Fade the clip in on this, never on `mayPlay`. */
    playing: boolean;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    onPlaying: () => void;
} => {
    const [playing, setPlaying] = useState(false);
    const videoRef = useRef<HTMLVideoElement>(null);

    const mayPlay = usePreviewSlot(
        Boolean(previewUrl) && (hovered || autoplay),
        hovered ? PREVIEW_PRIORITY_HOVER : PREVIEW_PRIORITY_GALLERY
    );

    /**
     * Start and stop the element to match the granted slot.
     *
     * `play()` rejects rather than throwing when the browser refuses — an autoplay policy, or
     * too many decoders already open. That is expected, not exceptional: the tile keeps its
     * cover and nothing is reported.
     */
    useEffect(() => {
        const video = videoRef.current;

        if (!video) {
            return;
        }

        if (mayPlay) {
            void video.play().catch(() => setPlaying(false));
            return;
        }

        video.pause();
        // Releasing the source is what actually frees the decoder; pausing alone does not on
        // several mobile browsers.
        video.removeAttribute("src");
        video.load();
        setPlaying(false);
    }, [mayPlay]);

    const onPlaying = useCallback(() => setPlaying(true), []);

    return { mayPlay, playing, videoRef, onPlaying };
};
