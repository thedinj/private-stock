"use client";

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { MediaListItem } from "@private-stock/core";

import { VideoPlayer } from "@/components/VideoPlayer";
import { PREVIEW_PRIORITY_VOICE } from "@/lib/previewBudget";
import { segmentProgress } from "@/lib/tasting/segment";
import { usePreviewSlot } from "@/lib/usePreviewSlot";
import { useHoverIntent, useTilePreview } from "@/lib/useTilePreview";

import classes from "./Showcase.module.scss";
import type { TileVoice, VoiceHandlers } from "./useShowcaseVoice";

/**
 * One picture on the showcase wall (§14f).
 *
 * The cover, and over it — once the preview budget grants a decoder — the preview clip,
 * faded in only when frames are actually arriving. Nothing is drawn over the picture; the
 * title is the link's accessible name only.
 */

interface ShowcaseTileProps {
    item: MediaListItem;
    x: number;
    y: number;
    width: number;
    height: number;
    /** In the middle of the screen: ask for a decoder without being hovered. */
    autoplay: boolean;
    /** The wall is drifting. A tile sliding under a still pointer has not been pointed at. */
    drifting: boolean;
    /** Which page of the set the tile is on, handed back when it is opened. */
    page: number;
    /**
     * Called as the tile is opened. The stage records where it was and opens the item
     * (`lib/openItem.ts`), which lights this tile while the item is on its way.
     */
    onOpen: (event: React.MouseEvent<HTMLAnchorElement>, page: number, itemId: string) => void;
    /** This tile's part in the wall's voice, if it has one (§14f). Null for nearly all. */
    voice: TileVoice | null;
    voiceHandlers: VoiceHandlers;
    /** The live voice's playhead, for the line along the bottom. */
    voicePositionRef: { current: number };
}

interface VoiceClipProps {
    item: MediaListItem;
    voice: TileVoice;
    handlers: VoiceHandlers;
    positionRef: { current: number };
    onShown: (shown: boolean) => void;
}

/**
 * A taste of the film, with sound, laid over the tile (§14f).
 *
 * The tasting's bare player (§14g), unchanged: live, it plays its span and says when it is over;
 * cued, it is held on its in point out of sight, so that taking over is a fade rather than a
 * download. It takes a decoder from the preview budget above every silent montage.
 */
const VoiceClip: React.FC<VoiceClipProps> = ({ item, voice, handlers, positionRef, onShown }) => {
    const granted = usePreviewSlot(true, PREVIEW_PRIORITY_VOICE);
    const live = voice.role === "live";
    const [playing, setPlaying] = useState(false);
    const boxRef = useRef<HTMLDivElement>(null);

    // `playing` does not bubble, and React binds media events to the element itself; listened
    // for in the capture phase on the box, it is heard from whichever element the player shows.
    useEffect(() => {
        const box = boxRef.current;

        if (!box) return;

        const onPlaying = () => setPlaying(true);

        box.addEventListener("playing", onPlaying, true);

        return () => box.removeEventListener("playing", onPlaying, true);
    }, [granted]);

    const shown = live && playing;

    useEffect(() => {
        onShown(shown);
    }, [shown, onShown]);

    useEffect(() => () => onShown(false), [onShown]);

    if (!granted) return null;

    return (
        <div ref={boxRef} className={classes.voice} data-shown={shown || undefined} aria-hidden>
            <VideoPlayer
                bare
                fit="cover"
                warmSource="showcase"
                mediaId={item.id}
                durationMs={item.durationMs}
                spriteVttUrl={null}
                poster={item.coverUrl}
                span={voice.span}
                held={!live}
                muted={voice.muted}
                reportProgress={false}
                positionRef={live ? positionRef : undefined}
                onSpanEnded={live ? () => handlers.onFinished(voice.token) : undefined}
                onEnded={live ? () => handlers.onFinished(voice.token) : undefined}
                onUnplayable={() => handlers.onUnplayable(item.id)}
                onPlayRefused={live ? () => handlers.onRefused(voice.token) : undefined}
            />
        </div>
    );
};

/** The line along the bottom of the speaking tile, drawn from the playhead without React. */
const VoiceLine: React.FC<{ voice: TileVoice; positionRef: { current: number } }> = ({
    voice,
    positionRef,
}) => {
    const lineRef = useRef<HTMLDivElement>(null);
    const { startMs, endMs } = voice.span;

    useEffect(() => {
        const line = lineRef.current;

        if (!line) return;

        let frame = 0;
        const draw = () => {
            line.style.transform = `scaleX(${segmentProgress(positionRef.current, { startMs, endMs })})`;
            frame = requestAnimationFrame(draw);
        };

        frame = requestAnimationFrame(draw);

        return () => cancelAnimationFrame(frame);
    }, [positionRef, startMs, endMs]);

    return <div ref={lineRef} className={classes.voiceLine} aria-hidden />;
};

const ShowcaseTileBase: React.FC<ShowcaseTileProps> = ({
    item,
    x,
    y,
    width,
    height,
    autoplay,
    drifting,
    page,
    onOpen,
    voice,
    voiceHandlers,
    voicePositionRef,
}) => {
    const { hovered, onEnter, onLeave } = useHoverIntent();
    const pointed = hovered && !drifting;
    // Once the voice has frames, the silent montage under it lets its decoder go.
    const [voiceShown, setVoiceShown] = useState(false);
    const { mayPlay, playing, videoRef, onPlaying } = useTilePreview(
        item.previewUrl,
        pointed && !voiceShown,
        autoplay && !voiceShown
    );
    const speaking = voice?.role === "live" && voiceShown;

    return (
        <Link
            href={`/media/${item.id}`}
            prefetch={false}
            className={classes.tile}
            aria-label={item.title}
            data-pointed={pointed || undefined}
            data-voiced={speaking || undefined}
            draggable={false}
            style={{ left: x, top: y, width, height }}
            onClick={(event) => onOpen(event, page, item.id)}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            onFocus={onEnter}
            onBlur={onLeave}
        >
            {item.coverUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={item.coverUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className={classes.cover}
                />
            )}

            {mayPlay && item.previewUrl && (
                <video
                    ref={videoRef}
                    src={item.previewUrl}
                    className={classes.clip}
                    // Muted is not a preference here: it is the condition browsers require
                    // before they will autoplay anything at all.
                    muted
                    loop
                    playsInline
                    preload="none"
                    aria-hidden
                    onPlaying={onPlaying}
                    style={{ opacity: playing ? 1 : 0 }}
                />
            )}

            {voice && (
                // Not keyed by role: the cued player becoming live keeps its element, which is
                // the whole point of having cued it.
                <VoiceClip
                    item={item}
                    voice={voice}
                    handlers={voiceHandlers}
                    positionRef={voicePositionRef}
                    onShown={setVoiceShown}
                />
            )}

            {speaking && voice && <VoiceLine voice={voice} positionRef={voicePositionRef} />}
        </Link>
    );
};

export const ShowcaseTile = memo(ShowcaseTileBase);
