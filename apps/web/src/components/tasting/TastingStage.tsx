"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Loader, Stack, Text } from "@mantine/core";

import type { MediaListItem } from "@private-stock/core";

import { PlayGlyph } from "@/components/media/Glyph";
import { StillSlots } from "@/components/media/StillSlots";
import { VideoPlayer } from "@/components/VideoPlayer";
import {
    useTastingClipSeconds,
    usePlaybackPref,
    useTastingPhotoSeconds,
} from "@/lib/playbackPrefs";
import { rememberReturnTo } from "@/lib/returnTo";
import { type ShowcaseSet, showcaseSetKey } from "@/lib/showcase/set";
import { readTastingPosition, saveTastingPosition } from "@/lib/tasting/restore";
import { pickSegment, segmentAt, segmentProgress, type Segment } from "@/lib/tasting/segment";
import { seek, type Cursor, type Seek } from "@/lib/tasting/sequence";
import { stageTargets } from "@/lib/tasting/targets";
import { isTypingTarget } from "@/lib/typingTarget";
import { useIdleControls } from "@/lib/useIdleControls";
import { usePlayerFullscreen } from "@/lib/usePlayerFullscreen";
import { useStillDwell } from "@/lib/useStillDwell";
import { useWakingTap } from "@/lib/useWakingTap";
import { mayWarmNextItem } from "@/lib/videoWarming";

import { TastingControls } from "./TastingControls";
import { useTastingPages } from "./useTastingPages";

import classes from "./Tasting.module.scss";

/**
 * The tasting (§14g): the filtered library or a playlist, one item at a time, a few seconds of
 * each.
 *
 * A film plays a random segment of the clip length; a photograph is held for the photo length;
 * then the next, round and round. The set and its order are the grid's, read from the same
 * address the showcase reads.
 *
 * **Two layers, one showing.** A film layer (a bare `VideoPlayer`) and a picture layer
 * (`StillSlots`), stacked, crossfading as the set turns from one kind to the other. Each also
 * gets the next item ready -- see `stageTargets` -- so a join is a change of which layer is
 * lit rather than a download.
 *
 * **Nothing is written.** No resume position and no watched mark, for films or photographs: a
 * few seconds from the middle of something is not watching it, exactly as a reel is not (§14d).
 */

interface TastingStageProps {
    /** What is being tasted. Memoised by the caller: a new object is a new set. */
    set: ShowcaseSet;
    onExit: () => void;
}

/** How long the layers take to cross, and how long the outgoing one is left alone meanwhile. */
const FADE_MS = 420;

/**
 * How long an item may sit without moving before it is given up on.
 *
 * A film whose playhead has not advanced, or a picture whose clock has not started, in this long
 * is a stalled file on a busy NAS or a decode that will never finish -- and a show running
 * unattended must not wait in front of it for ever. Long enough for a cold file with its index
 * at the end to arrive.
 */
const STALL_MS = 15_000;

/** Horizontal travel that makes a touch a swipe to the next or previous item. */
const SWIPE_PX = 60;

interface Visit {
    segment: Segment | null;
    token: number;
    holdMs: number;
}

/** What the film layer holds: the item, its span, and whether it is the one on show. */
interface VideoLayer {
    item: MediaListItem;
    span: { startMs: number; endMs: number; speed: null; token: string };
    live: boolean;
    preload: { id: string; startMs: number } | null;
}

interface Reservation {
    segment: Segment;
    clipMs: number;
    token: number;
}

const streamUrl = (id: string): string => `/api/media/${id}/stream`;

const needed = (result: Seek | null): number | null =>
    result?.kind === "need" ? result.page : null;

export const TastingStage: React.FC<TastingStageProps> = ({ set, onExit }) => {
    const filter = showcaseSetKey(set);
    const router = useRouter();
    const stageRef = useRef<HTMLDivElement | null>(null);
    const {
        isFullscreen,
        toggle: toggleFullscreen,
        attachContainer,
    } = usePlayerFullscreen(stageRef);

    const { pages, ensure, release, errorPage, retry } = useTastingPages(set);
    const [clipSeconds, setClipSeconds] = useTastingClipSeconds();
    const [photoSeconds, setPhotoSeconds] = useTastingPhotoSeconds();
    const [muted, setMuted] = usePlaybackPref("muted");

    const [held, setHeld] = useState(false);
    const [refused, setRefused] = useState(false);
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    const [lengthsOpen, setLengthsOpen] = useState(false);
    const [mayCue, setMayCue] = useState(false);

    // Asked after mount: it reads `navigator.connection`, which the server does not have.
    useEffect(() => setMayCue(mayWarmNextItem()), []);

    /**
     * Where the show is looking from, and which arrival that is.
     *
     * Null until mount, because where to begin is read from session storage: from the start, or
     * from the item the viewer was last on when the tasting is being returned to.
     */
    const [cursor, setCursor] = useState<{ value: Cursor; nonce: number } | null>(null);

    useEffect(() => {
        const saved = readTastingPosition(filter);

        setCursor({
            value: saved
                ? { kind: "anchor", page: saved.page, itemId: saved.itemId }
                : { kind: "start" },
            nonce: 0,
        });
        setFailed(new Set());
    }, [filter]);

    /**
     * The item on stage, derived rather than stored.
     *
     * Derived so that giving up on an item is nothing more than adding it to `failed`: the same
     * cursor then resolves to the next thing that can be tasted, with no second path for "skip".
     */
    const result = useMemo(
        () => (cursor ? seek(cursor.value, pages, failed) : null),
        [cursor, pages, failed]
    );
    const current = result?.kind === "found" ? result : null;

    const upcomingResult = useMemo(
        () =>
            current
                ? seek({ kind: "step", from: current.position, direction: 1 }, pages, failed)
                : null,
        [current, pages, failed]
    );
    const upcoming = upcomingResult?.kind === "found" ? upcomingResult.item : null;

    // Whatever either question is waiting on.
    const needCurrent = needed(result);
    const needUpcoming = needed(upcomingResult);

    useEffect(() => {
        if (needCurrent !== null) ensure(needCurrent);
        if (needUpcoming !== null) ensure(needUpcoming);
    }, [needCurrent, needUpcoming, ensure]);

    const currentPage = current?.position.page ?? null;

    useEffect(() => {
        if (currentPage !== null) release(currentPage);
    }, [currentPage, release]);

    /** Which arrival this is: every clock, latch and segment keys on it. */
    const serial = current && cursor ? `${cursor.nonce}:${current.item.id}` : null;
    const serialRef = useRef(serial);

    serialRef.current = serial;

    /**
     * Segments, chosen once per arrival and kept.
     *
     * The next film's segment is **reserved** before it arrives, because the player warms it
     * from its in point (`preloadStartMs`): warming from a start the arrival then did not use
     * would buffer the wrong seconds. The arrival takes the reservation and it is gone, so the
     * next lap round the set gets a fresh random moment.
     *
     * Written during render, idempotently: an arrival or a reservation that exists is returned
     * as it is, so a second render -- React's development double-render among them -- cannot
     * roll the dice again.
     */
    const visits = useRef(new Map<string, Visit>());
    const reservations = useRef(new Map<string, Reservation>());
    const tokens = useRef(0);
    const clipMs = clipSeconds * 1_000;

    const momentOf = (mediaId: string): number | undefined => {
        for (const page of pages.values()) {
            const atMs = page.moments?.[mediaId];

            if (atMs !== undefined) return atMs;
        }

        return undefined;
    };

    const reserve = (item: MediaListItem): Reservation => {
        const existing = reservations.current.get(item.id);

        if (existing && existing.clipMs === clipMs) {
            return existing;
        }

        tokens.current += 1;

        // A look's set opens each item on its match; anything else, on a random moment.
        const matchedAt = momentOf(item.id);
        const fresh = {
            segment:
                matchedAt === undefined
                    ? pickSegment(item.durationMs, clipMs)
                    : segmentAt(item.durationMs, clipMs, matchedAt),
            clipMs,
            token: tokens.current,
        };

        reservations.current.set(item.id, fresh);

        return fresh;
    };

    let visit: Visit | null = null;

    if (current && serial) {
        visit = visits.current.get(serial) ?? null;

        if (!visit) {
            const reservation = current.item.kind === "video" ? reserve(current.item) : null;

            tokens.current += 1;
            visit = {
                segment: reservation?.segment ?? null,
                token: reservation?.token ?? tokens.current,
                holdMs: photoSeconds * 1_000,
            };

            // One arrival at a time, and nothing reserved but what comes next.
            visits.current = new Map([[serial, visit]]);
            reservations.current = new Map();
        }
    }

    const upcomingReservation = upcoming?.kind === "video" ? reserve(upcoming) : null;

    /**
     * Stepping. A step is a new cursor, so it is a new arrival even at the same item -- a set
     * of one plays a fresh moment of itself each time round.
     *
     * Stepping lets go of a hold: somebody pressing Next wants to see the next thing, not a
     * paused frame of it.
     */
    const freezeRef = useRef<(() => void) | null>(null);

    const step = useCallback(
        (direction: 1 | -1) => {
            if (!current) return;

            // Back from the very first item before the end of the set is known has nowhere to go.
            if (
                direction === -1 &&
                seek({ kind: "step", from: current.position, direction: -1 }, pages, failed)
                    .kind === "none"
            ) {
                return;
            }

            // Hold the last frame across a film-to-film join, as a reel does (§14d).
            if (current.item.kind === "video") freezeRef.current?.();

            setHeld(false);
            setRefused(false);
            setCursor((previous) => ({
                value: { kind: "step", from: current.position, direction },
                nonce: (previous?.nonce ?? 0) + 1,
            }));
        },
        [current, pages, failed]
    );

    /** The thing on stage has had its time. Only the arrival that is still on stage may say so. */
    const finished = useCallback(
        (from: string | null) => {
            if (from !== null && from === serialRef.current) step(1);
        },
        [step]
    );

    const giveUp = useCallback((id: string) => {
        setFailed((previous) => {
            if (previous.has(id)) return previous;

            const next = new Set(previous);

            next.add(id);

            return next;
        });
    }, []);

    // --- Photographs ---

    /** Which picture `StillSlots` last said it could paint. */
    const [paintedId, setPaintedId] = useState<string | null>(null);

    const photoOnStage = current?.item.kind === "image";
    const dwell = useStillDwell({
        arrivalKey: serial ?? "",
        dwellMs: photoOnStage && visit ? visit.holdMs : null,
        held,
        onEnded: () => finished(serial),
    });
    const { begin } = dwell;

    useEffect(() => {
        if (photoOnStage && current && paintedId === current.item.id) begin();
    }, [photoOnStage, current, paintedId, begin]);

    // --- Layers ---

    /**
     * Whether the non-showing layer may take up the next item yet.
     *
     * Not until the crossfade is over: the outgoing layer is still visible while it fades, and
     * swapping what it holds in that moment would flash the next item's first frame through
     * the dissolve. Until then it keeps what it had, held.
     */
    const [settledSerial, setSettledSerial] = useState<string | null>(null);

    useEffect(() => {
        if (serial === null) return;

        const timer = setTimeout(() => setSettledSerial(serial), FADE_MS);

        return () => clearTimeout(timer);
    }, [serial]);

    const cueReady = settledSerial === serial;
    const targets = current ? stageTargets(current.item, upcoming, mayCue) : null;

    const lastVideoLayer = useRef<VideoLayer | null>(null);
    const lastPhotoLayer = useRef<{ item: MediaListItem; live: boolean } | null>(null);

    let videoLayer: VideoLayer | null = null;

    if (targets?.video && targets.videoLive && visit?.segment) {
        videoLayer = {
            item: targets.video,
            span: { ...visit.segment, speed: null, token: `${targets.video.id}:${visit.token}` },
            live: true,
            preload:
                targets.videoPreload && upcomingReservation
                    ? {
                          id: targets.videoPreload.id,
                          startMs: upcomingReservation.segment.startMs,
                      }
                    : null,
        };
    } else if (cueReady) {
        videoLayer =
            targets?.video && upcomingReservation
                ? {
                      item: targets.video,
                      span: {
                          ...upcomingReservation.segment,
                          speed: null,
                          token: `${targets.video.id}:${upcomingReservation.token}`,
                      },
                      live: false,
                      preload: null,
                  }
                : null;
    } else if (lastVideoLayer.current) {
        videoLayer = { ...lastVideoLayer.current, live: false, preload: null };
    }

    lastVideoLayer.current = videoLayer;

    let photoLayer: { item: MediaListItem; live: boolean } | null = null;

    if (targets?.photo && targets.photoLive) {
        photoLayer = { item: targets.photo, live: true };
    } else if (cueReady) {
        photoLayer = targets?.photo ? { item: targets.photo, live: false } : null;
    } else if (lastPhotoLayer.current) {
        photoLayer = { ...lastPhotoLayer.current, live: false };
    }

    lastPhotoLayer.current = photoLayer;

    const photoPreload = targets?.photoLive ? targets.photoPreload : null;
    const videoLayerId = videoLayer?.item.id ?? null;

    // --- The playhead, the stall watchdog and the progress line ---

    const positionRef = useRef(0);
    const progressRef = useRef<HTMLDivElement | null>(null);
    const videoOnStage = current?.item.kind === "video";
    const segment = visit?.segment ?? null;

    /**
     * The line under a film, drawn from the playhead without React.
     *
     * One transform per frame, written straight to the element: re-rendering the stage sixty
     * times a second to move a line is the cost `positionRef` exists to avoid.
     */
    useEffect(() => {
        const line = progressRef.current;

        if (!videoOnStage || !segment || !line) return;

        let frame = 0;
        const draw = () => {
            line.style.transform = `scaleX(${segmentProgress(positionRef.current, segment)})`;
            frame = requestAnimationFrame(draw);
        };

        frame = requestAnimationFrame(draw);

        return () => cancelAnimationFrame(frame);
    }, [videoOnStage, segment, serial]);

    const dwellRunning = dwell.running;
    const dwellRunningRef = useRef(dwellRunning);

    dwellRunningRef.current = dwellRunning;

    /**
     * Giving up on an item that has stopped moving.
     *
     * Motion is a playhead that advanced, or a picture's clock that is running. A hold, a
     * refused start and a hidden tab are all somebody else's reason for stillness and reset the
     * count rather than adding to it.
     */
    useEffect(() => {
        if (!current || held) return;

        const id = current.item.id;
        let lastPosition = positionRef.current;
        let lastMotion = Date.now();

        const timer = setInterval(() => {
            const now = Date.now();
            const moved =
                current.item.kind === "video"
                    ? positionRef.current !== lastPosition
                    : dwellRunningRef.current;

            lastPosition = positionRef.current;

            if (moved || document.hidden) {
                lastMotion = now;
            } else if (now - lastMotion > STALL_MS) {
                giveUp(id);
            }
        }, 1_000);

        return () => clearInterval(timer);
    }, [current, held, giveUp]);

    // --- Controls ---

    const [pointerOnControls, setPointerOnControls] = useState(false);
    const holdControls = useCallback(
        () => held || lengthsOpen || pointerOnControls || !current,
        [held, lengthsOpen, pointerOnControls, current]
    );
    const idle = useIdleControls(true, holdControls);

    const togglePlay = useCallback(() => {
        setRefused(false);
        setHeld((value) => !value);
    }, []);

    const openItem = useCallback(() => {
        if (!current) return;

        saveTastingPosition({ filter, page: current.position.page, itemId: current.item.id });

        /**
         * The address, and the page the item sits on, so the viewer knows which set it is in and
         * where -- and can offer the next item and warm it, from the same cache (§14f).
         */
        const address = new URLSearchParams(window.location.search);

        address.set("page", String(current.position.page));
        rememberReturnTo(`${window.location.pathname}?${address.toString()}`);
        router.push(`/media/${current.item.id}`);
    }, [current, filter, router]);

    // Read from the key handler, which is bound once.
    const keys = useRef({ step, togglePlay, openItem, toggleFullscreen, onExit, setMuted, muted });

    keys.current = { step, togglePlay, openItem, toggleFullscreen, onExit, setMuted, muted };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
                return;
            }

            const act = keys.current;

            switch (event.key) {
                case " ":
                    event.preventDefault();
                    act.togglePlay();
                    break;
                case "ArrowRight":
                case "n":
                    event.preventDefault();
                    act.step(1);
                    break;
                case "ArrowLeft":
                case "p":
                    event.preventDefault();
                    act.step(-1);
                    break;
                case "m":
                    act.setMuted(!act.muted);
                    break;
                case "o":
                    act.openItem();
                    break;
                case "f":
                case "F":
                    act.toggleFullscreen();
                    break;
                case "Escape":
                    // In full screen the browser takes Escape to leave it; only after that does
                    // it mean leaving the tasting.
                    if (!document.fullscreenElement) act.onExit();
                    break;
            }
        };

        document.addEventListener("keydown", onKey);

        return () => document.removeEventListener("keydown", onKey);
    }, []);

    /**
     * The picture is the pause button, and a swipe steps.
     *
     * A tap that only brought the hidden controls back does nothing else (`useWakingTap`, the
     * showcase's rule too): somebody reaching for the transport should not stop the show on the
     * way.
     */
    const pointerStart = useRef<{ x: number; y: number } | null>(null);
    const swiped = useRef(false);
    const wakingTap = useWakingTap(idle);

    const onPointerDown = (event: React.PointerEvent) => {
        pointerStart.current = { x: event.clientX, y: event.clientY };
        swiped.current = false;
        wakingTap.onPointerDown(event);
    };

    const onPointerUp = (event: React.PointerEvent) => {
        const start = pointerStart.current;

        if (!start || event.pointerType === "mouse") return;

        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;

        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
            swiped.current = true;
            step(dx < 0 ? 1 : -1);
        }
    };

    const onClick = () => {
        pointerStart.current = null;

        // Consumed whatever else is true, so it cannot outlive the tap it belongs to.
        const onlyWoke = wakingTap.consume();

        if (swiped.current || onlyWoke || !current) return;

        togglePlay();
    };

    // --- What is on screen ---

    const firstPage = pages.get(0);
    const emptySet = firstPage !== undefined && firstPage.items.length === 0 && !firstPage.hasMore;
    const waitingOn = !current && result?.kind === "need" ? result.page : null;

    return (
        <div
            ref={attachContainer}
            className={classes.stage}
            data-idle={idle || undefined}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onClick={onClick}
        >
            <div className={classes.layer} data-live={videoLayer?.live || undefined}>
                {videoLayer && (
                    <VideoPlayer
                        bare
                        warmSource="tasting"
                        mediaId={videoLayer.item.id}
                        durationMs={videoLayer.item.durationMs}
                        spriteVttUrl={null}
                        poster={videoLayer.item.coverUrl}
                        span={videoLayer.span}
                        held={!videoLayer.live || held}
                        muted={muted}
                        reportProgress={false}
                        positionRef={videoLayer.live ? positionRef : undefined}
                        freezeRef={freezeRef}
                        preloadMediaId={videoLayer.preload?.id ?? null}
                        preloadStartMs={videoLayer.preload?.startMs ?? null}
                        onSpanEnded={videoLayer.live ? () => finished(serial) : undefined}
                        onEnded={videoLayer.live ? () => finished(serial) : undefined}
                        onUnplayable={() => videoLayerId && giveUp(videoLayerId)}
                        onPlayRefused={
                            videoLayer.live
                                ? () => {
                                      setHeld(true);
                                      setRefused(true);
                                  }
                                : undefined
                        }
                    />
                )}
            </div>

            <div className={classes.layer} data-live={photoLayer?.live || undefined}>
                {photoLayer && (
                    <StillSlots
                        warmSource="tasting-still"
                        cued={!photoLayer.live}
                        mediaId={photoLayer.item.id}
                        src={streamUrl(photoLayer.item.id)}
                        alt={photoLayer.item.title}
                        preloadMediaId={photoPreload?.id ?? null}
                        preloadSrc={photoPreload ? streamUrl(photoPreload.id) : null}
                        onPaintable={setPaintedId}
                        onFailed={giveUp}
                    />
                )}
            </div>

            {current && (
                <div className={classes.progress} aria-hidden>
                    {videoOnStage ? (
                        <div ref={progressRef} className={classes.progressFill} />
                    ) : (
                        <div
                            // Remounted per arrival, which is what restarts the sweep; paused in
                            // place rather than reset, as the viewer's dwell line is.
                            key={serial}
                            className={classes.progressDwell}
                            data-held={!dwell.running || undefined}
                            style={
                                { "--ps-dwell": `${visit?.holdMs ?? 0}ms` } as React.CSSProperties
                            }
                        />
                    )}
                </div>
            )}

            {!current && (
                <div className={classes.centre}>
                    {waitingOn !== null && errorPage === waitingOn ? (
                        <Stack align="center" gap="sm">
                            <Text c="dimmed" size="sm">
                                The next part of this set did not load.
                            </Text>
                            <Button variant="light" onClick={retry}>
                                Try again
                            </Button>
                        </Stack>
                    ) : result?.kind === "none" ? (
                        <Text c="dimmed" size="sm" ta="center" px="md">
                            {emptySet
                                ? "Nothing here to taste."
                                : "Nothing here can be played in this browser yet."}
                        </Text>
                    ) : (
                        <Loader color="brass" type="dots" />
                    )}
                </div>
            )}

            {refused && held && current && (
                <button
                    type="button"
                    className={classes.start}
                    aria-label="Start the tasting"
                    onClick={(event) => {
                        event.stopPropagation();
                        togglePlay();
                    }}
                >
                    <PlayGlyph />
                </button>
            )}

            <TastingControls
                title={current?.item.title ?? null}
                held={held}
                muted={muted}
                hasItem={current !== null}
                isFullscreen={isFullscreen}
                clipSeconds={clipSeconds}
                photoSeconds={photoSeconds}
                lengthsOpen={lengthsOpen}
                onLengthsOpen={setLengthsOpen}
                onClipSeconds={setClipSeconds}
                onPhotoSeconds={setPhotoSeconds}
                onTogglePlay={togglePlay}
                onPrevious={() => step(-1)}
                onNext={() => step(1)}
                onToggleMute={() => setMuted(!muted)}
                onOpen={openItem}
                onToggleFullscreen={toggleFullscreen}
                onClose={onExit}
                onPointerOnControls={setPointerOnControls}
            />
        </div>
    );
};
