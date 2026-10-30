"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Box, Button, Group, Menu, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { ReleasingVideo } from "@/components/media/ReleasingVideo";
import { SpriteScrubber } from "@/components/SpriteScrubber";
import { api } from "@/lib/api/client";
import { readPlaybackPref, usePlaybackPref } from "@/lib/playbackPrefs";
import { effectiveRate, spanRunMs } from "@private-stock/core";

import { assignSlots, initialSlots } from "@/lib/videoSlots";
import { useOutPoint } from "@/lib/useOutPoint";
import { useIdleControls } from "@/lib/useIdleControls";
import { usePlayerFullscreen } from "@/lib/usePlayerFullscreen";
import { mayWarmNextItem } from "@/lib/videoWarming";
import { openingTarget, rememberPosition, visitPosition } from "@/lib/resumePoint";
import { isTypingTarget } from "@/lib/typingTarget";
import { useScreenWakeLock } from "@/lib/useScreenWakeLock";
import { PLAY_REFUSED_EVENT, useWarmReport, videoProbe } from "@/lib/useWarmReport";
import type { WarmGate, WarmSource } from "@/lib/warmMonitor";

import {
    CheckGlyph,
    FullscreenGlyph,
    Glyph,
    MoreGlyph,
    MutedGlyph,
    NextGlyph,
    PauseGlyph,
    PlayGlyph,
    PreviousGlyph,
    ScissorsGlyph,
    SoundGlyph,
} from "./media/Glyph";

import classes from "./VideoPlayer.module.scss";

/**
 * The video player.
 *
 * Phase 1 is direct play only: the native element streaming the original file over HTTP
 * ranges (§8). Keyboard control and touch gestures are both first-class here rather than one
 * being a translation of the other — a double-tap is not a right-arrow, and pretending
 * otherwise produces a player that is awkward on both.
 */

interface VideoPlayerProps {
    mediaId: string;
    durationMs: number | null;
    /**
     * A moment the page's address named (`?at=`), which wins over where the item was left this
     * visit and is not subject to its edges. See `openingTarget`.
     */
    startAtMs?: number | null;
    onUnplayable?: () => void;
    /** WebVTT thumbnail track for the scrubber, or null until the sprite job has run. */
    spriteVttUrl: string | null;
    /**
     * The cover, shown until the first frame decodes.
     *
     * `preload="metadata"` fetches enough to know the duration and no pixels, so without this
     * the player is a black rectangle until you press play — on a page whose entire job is to
     * present one thing well. The cover already exists for every probed item.
     */
    poster?: string | null;
    /**
     * Start playing as soon as the item opens (§14b).
     *
     * Attempted with sound and allowed to fail. The usual workaround for the browser's
     * autoplay policy is to start muted and offer a "tap for sound" control; that was
     * considered and rejected, because a library of home video played silently by default is
     * worse than one that occasionally waits for you to press play. So on a browser that has
     * not yet earned the permission, the video simply sits there — a deliberate, visible
     * inconsistency on a first visit rather than a silent muting.
     */
    autoPlay?: boolean;
    /** Called when playback reaches the end, for rolling on to the next item. */
    onEnded?: () => void;
    /**
     * Kept pointing at the playhead, in milliseconds, for whatever needs to read it (§13).
     *
     * A ref rather than a callback because the only reader is a button that fires on a
     * click: an `onPosition` prop would re-render the page four times a second for a value
     * nothing is displaying, and the page holds a video player.
     */
    positionRef?: { current: number };
    /**
     * Grab the frame at a position, in milliseconds (§13).
     *
     * The player owns the control and the key; the page owns what happens next, because the
     * result is an artifact of the item rather than a fact about playback. Absent for an
     * item with no frames to take, which is how the control disappears for an image.
     */
    onCapture?: (atMs: number) => void;
    capturing?: boolean;
    captureFailed?: boolean;
    /**
     * Filled with a function that moves the playhead, for callers outside the player.
     *
     * A ref handed downwards rather than a `seekTo` prop handed upwards, because the caller
     * needs to *ask* rather than be told, and the player is the only thing that owns the
     * element. Used by the enlarged frame view to return to the moment a still was taken.
     */
    seekRef?: { current: ((ms: number) => void) | null };
    /**
     * The element on screen, for a caller that needs the picture it is showing: "Who is this?"
     * draws the frame somebody stopped on (§5f). Handed down like `seekRef`; kept pointing at
     * whichever element is playing, the warmed one after a swap included.
     */
    elementRef?: { current: HTMLVideoElement | null };
    /**
     * The item to warm in the background, or null (§8b).
     *
     * The player renders a second, hidden `<video>` for it, so that opening it is a swap of
     * which element is on screen instead of a download. The caller decides what is worth
     * warming — it needs the set to know what comes next and the next item's details to know
     * whether it can be played directly at all — and this component decides whether the
     * device should be spending the bandwidth.
     */
    preloadMediaId?: string | null;
    /**
     * Where in the warmed item playback will start, in milliseconds (§14d).
     *
     * **The detail that decides whether warming helps a reel at all.** `preload="auto"` buffers
     * from `currentTime`, which is zero, so warming a two-hour file for a span that begins at
     * 01:40 buffers its opening titles — the wrong thirty seconds, and the join stalls exactly
     * as if nothing had been warmed. Stepping through the library never noticed, because there
     * the next item starts at the beginning.
     */
    preloadStartMs?: number | null;
    /**
     * The span to play, or null for the whole file (§14d).
     *
     * Playback starts at `startMs` on arrival, runs at the clip's own speed multiplied by the
     * viewer's rate, and `onSpanEnded` fires at the out-point.
     */
    span?: {
        startMs: number;
        endMs: number;
        speed: number | null;
        /**
         * Where to begin, when that is not the in point.
         *
         * Seeking a reel lands part way into a span, and "play this span from 4 seconds in" is a
         * different instruction from "play this span". Absent means start at `startMs`.
         */
        startAtMs?: number;
        /**
         * Which arrival this is — a reel item's id, or a counter on the item page.
         *
         * Two consecutive spans can be identical: a reel may hold the same clip twice, which is a
         * refrain and a legitimate cut (§14d), and pressing preview again on the clip that just
         * finished is the same request twice. Keyed only by the timecodes, neither would re-arrive
         * and neither would replay.
         */
        token?: string | number;
    } | null;
    onSpanEnded?: () => void;
    /**
     * Whether to record where the viewer got to.
     *
     * False in reel mode, and this is not a nicety. The player marks an item watched after thirty
     * seconds of uninterrupted playback and remembers where it was left, so a reel of twenty spans
     * would otherwise mark twenty films watched and reopen each in its *middle* — from a viewing
     * that was never about any of them.
     */
    reportProgress?: boolean;
    /**
     * Mark the in and out points of a span, bound to `[` and `]` (§14's keymap).
     *
     * The player owns the *selection*, which is a fact about playback; the page owns the *save*,
     * which is a row about the item. The same split `onCapture` uses.
     */
    onMarkIn?: (atMs: number) => void;
    onMarkOut?: (atMs: number) => void;
    /**
     * Whether what was being played has finished, with nothing after it.
     *
     * Only a reel has this: a file ends at its own end and the element knows. A reel ends when its
     * last span does, which is a fact the player has no way to work out — so while this is set the
     * transport offers **replay** rather than play, and pressing it calls `onReplay` instead of
     * resuming an element that is sitting on an out point.
     */
    atEnd?: boolean;
    onReplay?: () => void;
    /**
     * Filled with a function that holds the picture on its current frame (§14d).
     *
     * A ref handed downwards rather than a prop handed up, like `seekRef`: the caller needs to
     * *ask*, at the moment it changes what is playing, and only the player owns the element.
     */
    freezeRef?: { current: (() => void) | null };
    /**
     * Measure the bar against something other than this file (§14d).
     *
     * A reel is one thing to watch, so its progress bar has to be the reel's: `offsetMs` is how
     * much of it ran before this span, and `totalMs` is the whole of it. Without this the bar
     * showed the position inside whichever file the current span came from — so a reel ending on
     * a clip taken from the middle of a long video finished with the bar at a puzzling 88%, and
     * every join made it jump backwards.
     *
     * `onSeek` takes a position **in reel time**, which the owner maps back to a span and an
     * offset inside it. This was briefly a read-only bar, on the reasoning that dragging it would
     * have to mean either scrubbing one span or seeking across them. That was the wrong call: a
     * bar that fills as you watch is a bar people expect to drag, the reel is the thing they are
     * watching, and with no way to move in it there was no way to play one a second time.
     */
    timeline?: {
        offsetMs: number;
        totalMs: number;
        onSeek: (reelMs: number) => void;
    } | null;
    /** Spans already marked on this item, drawn in a lane under the scrubber. */
    clipMarks?: { id: string; startMs: number; endMs: number; label: string | null }[];
    /** The span being marked right now, highlighted on the scrubber. */
    selection?: { startMs: number; endMs: number | null } | null;
    /**
     * Whether the keyboard belongs to the player right now.
     *
     * False while something is open over it. The handler is bound to the document so that
     * space works the moment the page loads, which means it also hears keys aimed at a
     * lightbox — and ←/→ moving between captures and seeking the video at the same time is
     * the kind of bug that reads as the page being haunted.
     */
    hotkeys?: boolean;
    /**
     * The picture and nothing else, for a stage that brings its own transport (§14g).
     *
     * No control bar, no keys, no click or double-tap on the picture, and no fullscreen styling
     * of its own: the tasting lays this in a layer that already fills the screen, and the
     * player's `data-fullscreen` would lift it above that stage's controls. The element, the
     * warming, the span and the held frame are all unchanged -- they are why it is reused.
     */
    bare?: boolean;
    /**
     * How a bare player fills its box: letterboxed (`contain`, the tasting's full screen) or
     * cropped to it (`cover`, a showcase tile, which is already cut to the picture's shape
     * within limits and must not show bars inside the wall — §14f).
     */
    fit?: "contain" | "cover";
    /**
     * Keep still: paused, and not started by an arriving span (§14g).
     *
     * A span that arrives while held is seeked to its in point and waits there, which is how
     * the tasting has the next film ready on the right frame before its turn. Letting go plays.
     */
    held?: boolean;
    /** Mute from outside, for a stage whose mute button is its own. */
    muted?: boolean;
    /**
     * The browser refused to start playback without a gesture.
     *
     * Only the span's own start reports it. A stage running unattended has to know, or it waits
     * for an out point a paused video will never reach.
     */
    onPlayRefused?: () => void;
    /**
     * Which of the three places this player is, for the warming overlay (§8b, "Seeing it
     * work"). Absent, the player reports nothing.
     */
    warmSource?: WarmSource;
    /**
     * The way through the set, at the two ends of the bar (§14b).
     *
     * In the bar rather than above the player because the bar is the one thing on screen in
     * fullscreen, where a phone otherwise had no way to the next item at all. A direction with
     * nowhere to go is null and its button stays, disabled, so nothing shifts under a thumb at the
     * end of a set. Absent -- a reel, a clip, an item opened outside a set -- and neither is drawn.
     */
    steps?: { previous: (() => void) | null; next: (() => void) | null } | null;
    /**
     * The page's own actions on the item, at the foot of the bar's "more" menu: the rating and
     * the bin. Here so they can be reached in fullscreen without a keyboard; Menu items, since
     * they are rendered inside the menu.
     */
    menuItems?: React.ReactNode;
}

/** Playback rates the speed control offers. The hotkeys can reach anything between. */
const ReplayGlyph = () => (
    <Glyph>
        <path
            d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"
            fill="currentColor"
            stroke="none"
        />
    </Glyph>
);

/**
 * Back ten seconds: an arrow turning backwards around the number it goes back by.
 *
 * Ten rather than five because it is the same distance as `j` and a double-tap on the left
 * third, so the bar, the keys and the thumb all agree on what "back a bit" means.
 */
const BackTenGlyph = () => (
    <Glyph>
        <path d="M5.5 9.5A7.5 7.5 0 1 1 4.5 13" />
        <path d="M5.5 5v4.5H10" />
        <text
            x="12.5"
            y="15.5"
            textAnchor="middle"
            fontSize="7.5"
            fontWeight="600"
            fill="currentColor"
            stroke="none"
        >
            10
        </text>
    </Glyph>
);

/** Forward ten seconds: the back glyph mirrored, matching `l` and a double-tap on the right third. */
const ForwardTenGlyph = () => (
    <Glyph>
        <path d="M18.5 9.5A7.5 7.5 0 1 0 19.5 13" />
        <path d="M18.5 5v4.5H14" />
        <text
            x="11.5"
            y="15.5"
            textAnchor="middle"
            fontSize="7.5"
            fontWeight="600"
            fill="currentColor"
            stroke="none"
        >
            10
        </text>
    </Glyph>
);

/**
 * A camera, for grabbing the frame on screen (§13).
 *
 * Drawn rather than typed, for the reason every other control here is: an emoji renders in
 * the system emoji font, in its own colours, differently on every platform — the one object
 * in a warm dark player that belongs to a different application.
 */
const CaptureGlyph = () => (
    <Glyph>
        <path d="M3 8h3l2-2h8l2 2h3v11H3z" />
        <circle cx="12" cy="13" r="3.5" />
    </Glyph>
);

/**
 * The speeds on offer.
 *
 * Down to a tenth: the slow end is for studying a moment -- a fall, a trick, a face -- frame by
 * frame without pausing, and a quarter speed is often still too quick for that. Browsers
 * accept rates down to about 0.0625; a tenth is the slowest that still reads as motion.
 */
const SPEEDS = ["0.1", "0.25", "0.5", "0.75", "1", "1.25", "1.5", "2"];

/** The slowest rate the keys step down to, matching the menu's slowest. */
const MIN_RATE = 0.1;

const formatTime = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};

/**
 * Say on the element that a `play()` was refused, for the warming overlay's timeline (§8b,
 * "Seeing it work"). The browser fires nothing when it refuses; the promise is all there is.
 * `AbortError` belongs here too: it is a `play()` interrupted by a load or a pause, which on a
 * swap is its own kind of answer to "why did it not start".
 */
const announceRefusal = (video: HTMLVideoElement, error: unknown): void => {
    const name = error instanceof DOMException ? error.name : "Error";

    video.dispatchEvent(new CustomEvent(PLAY_REFUSED_EVENT, { detail: name }));
};

/**
 * How long a held frame may stand in for the picture.
 *
 * Long enough for a cold file to find its index and seek — the case this exists for — and short
 * enough that a file which never arrives costs one bad join rather than a player that appears to
 * have stopped on a still.
 */
const FREEZE_LIMIT_MS = 4_000;

/**
 * How much uninterrupted playback marks an item watched (§14b).
 *
 * Capped at 90% of the duration for anything shorter, which is what makes the rule apply to
 * a library of clips at all rather than only to feature-length items.
 */
const WATCHED_AFTER_MS = 30_000;

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
    mediaId,
    durationMs,
    startAtMs = null,
    onUnplayable,
    spriteVttUrl,
    poster,
    autoPlay,
    onEnded,
    positionRef,
    onCapture,
    capturing = false,
    captureFailed = false,
    hotkeys = true,
    seekRef,
    elementRef,
    preloadMediaId = null,
    preloadStartMs = null,
    span = null,
    onSpanEnded,
    reportProgress = true,
    onMarkIn,
    onMarkOut,
    clipMarks = [],
    selection = null,
    timeline = null,
    atEnd = false,
    onReplay,
    freezeRef,
    bare = false,
    fit = "contain",
    held = false,
    muted: mutedProp,
    onPlayRefused,
    warmSource,
    steps = null,
    menuItems,
}) => {
    /**
     * The element on screen, held in state as well as in a ref.
     *
     * The ref is what the dozen handlers below read at the moment they fire. The state is what
     * the effects *depend on*: the element is no longer rebuilt for every item — that is the
     * whole point of warming one in advance — so an effect that binds listeners has to rebind
     * when the element it bound to is replaced by one that was already loaded. It used to be
     * enough for those effects to run once.
     */
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    /**
     * The item this player has already given up on, so it reports once per arrival.
     *
     * A ref rather than state: nothing here renders differently for it — the page is what puts a
     * picture on the stage instead — and a re-render would only re-run the effects that just
     * failed.
     */
    const reportedRef = useRef<string | null>(null);

    const reportUnplayable = () => {
        if (reportedRef.current === mediaId) {
            return;
        }

        reportedRef.current = mediaId;
        onUnplayable?.();
    };

    /**
     * The whole screen, and keeping it across the next item (§14b).
     *
     * The intention lives outside this component because this component does not: stepping to
     * the next item rebuilds the page, and with it the element that was fullscreen.
     */
    const {
        isFullscreen,
        toggle: toggleFullscreen,
        attachContainer,
    } = usePlayerFullscreen(containerRef);

    /**
     * Attached to whichever element is playing.
     *
     * **Nulls are ignored deliberately.** Both elements share this callback, and when the
     * active one changes React detaches the outgoing element's ref and attaches the incoming
     * one's in the same commit, in an order this must not depend on: honouring the detach would
     * leave the ref pointing at nothing while a perfectly good element was on screen.
     */
    const attach = useCallback((element: HTMLVideoElement | null) => {
        if (element === null || element === videoRef.current) return;

        videoRef.current = element;
        setVideoEl(element);
    }, []);

    /**
     * Whether the item on screen can play yet.
     *
     * The gate on warming the next one: two streams off the same disk is how a preload for
     * later becomes a stutter now, and the video somebody is actually watching has the prior
     * claim on the NAS. `canplay` is the moment that claim is satisfied — enough buffered to
     * start — rather than `canplaythrough`, which on a four-gigabyte file may never arrive.
     */
    const [settled, setSettled] = useState(false);

    /**
     * Whether this device should be warming anything, asked once after mount.
     *
     * Not during render: the answer on the server is "no" and the answer here may be "yes", and
     * that disagreement is a hydration mismatch about whether a second video element exists.
     */
    const [mayWarm, setMayWarm] = useState(false);

    useEffect(() => setMayWarm(mayWarmNextItem()), []);

    /**
     * Which of the two elements holds what (§8b), computed during render rather than in an
     * effect: an item that is already warmed must become visible in the same commit that
     * changed `mediaId`, not one paint later.
     *
     * `assignSlots` returns the object it was given when nothing moves, so this is stable.
     */
    const slotsRef = useRef<ReturnType<typeof initialSlots>>(initialSlots(mediaId));

    // Where the elements stood before this arrival, for the warming overlay's account of it.
    const previousSlots = slotsRef.current;

    slotsRef.current = assignSlots(
        slotsRef.current,
        mediaId,
        mayWarm && settled ? preloadMediaId : null
    );

    const slots = slotsRef.current;

    /**
     * Buffer the part of the next file that is actually going to be played (§14d).
     *
     * `preload="auto"` starts from `currentTime`, so without this a reel warms the opening
     * titles of a file it is about to join at 01:40 — the bandwidth is spent and the join still
     * stalls. Stepping through the library never needed it, because there the next item starts
     * at its beginning.
     *
     * Seeks once, on the hidden element, as soon as it knows how long it is. The same shape as
     * the resume seek below: immediately when the metadata is already there, otherwise on the
     * one event that says it has arrived.
     */
    /**
     * Held in **state**, not a ref, and the difference is the whole bug it fixes.
     *
     * The warmed element does not exist when this component first renders: the warming slot stays
     * empty until the *playing* element reaches `canplay`, because the current item has the prior
     * claim on the disk (§8b). By the time the element appears, `preloadMediaId` and
     * `preloadStartMs` have not changed — so an effect keyed only on those never re-ran, and
     * `warmingRef.current` had been null the one time it did.
     *
     * The result was a warmed element that was never seeked. It buffered from zero, and the swap
     * showed the **first frame of the next file** for as long as it took the arrival seek to
     * land: the one thing warming exists to prevent, arriving as a visible flash.
     *
     * §8b already records this exact lesson about the live element — "it is held in state as well
     * as in a ref: the ref is what the handlers read, and the state is what the effects depend
     * on". This is the same sentence about the other one.
     */
    const [warmingEl, setWarmingEl] = useState<HTMLVideoElement | null>(null);

    /** Ignores the detach, so a swap does not blank this between the two renders. */
    const attachWarming = useCallback((element: HTMLVideoElement | null) => {
        if (element) {
            setWarmingEl(element);
        }
    }, []);

    const warmGate: WarmGate = !mayWarm
        ? "refused"
        : preloadMediaId === null
          ? "none"
          : preloadMediaId === mediaId
            ? "same-file"
            : settled
              ? "warming"
              : "waiting";

    useWarmReport({
        source: warmSource,
        probe: videoProbe,
        mediaId,
        arrival: `${mediaId}|${span?.token ?? ""}`,
        held,
        slots: previousSlots,
        targetMs: span
            ? (span.startAtMs ?? span.startMs)
            : (openingTarget(
                  startAtMs,
                  reportProgress ? visitPosition(mediaId) : null,
                  durationMs
              ) ?? 0),
        offered: preloadMediaId === null ? null : { id: preloadMediaId, startMs: preloadStartMs },
        gate: warmGate,
        live: () => videoRef.current,
        /**
         * Never cleared by the player — `attachWarming` ignores a detach so a swap does not blank
         * it — so after a swap this can be the element now on screen. Not reported as warm then.
         */
        warming: () =>
            warmingEl !== null && warmingEl !== videoRef.current && warmingEl.isConnected
                ? warmingEl
                : null,
    });

    useEffect(() => {
        const video = warmingEl;

        if (!video || preloadStartMs === null || preloadStartMs <= 0) {
            return;
        }

        const seek = () => {
            video.currentTime = preloadStartMs / 1000;
        };

        if (video.readyState >= 1) {
            seek();

            return;
        }

        video.addEventListener("loadedmetadata", seek, { once: true });

        return () => video.removeEventListener("loadedmetadata", seek);
    }, [warmingEl, preloadMediaId, preloadStartMs]);

    /**
     * Arriving at a span: seek to its in point and set its rate (§14d).
     *
     * Runs on every arrival, keyed by the element as well as the span, because a swap hands the
     * player an element that is already several seconds into being ready — §8b's "the element
     * now outlives the item", arriving here as "the element now outlives the span".
     *
     * The rate is **reset on every arrival**, including back to normal. A half-speed span that
     * left the element at 0.5× would otherwise make the span after it slow too, which reads as
     * the player having broken rather than as the previous clip having a speed.
     *
     * Rate is not applied to the warmed element: `playbackRate` has no effect on buffering, so
     * there is nothing to gain by setting it early and a hidden element running at a rate it
     * will not keep is one more thing to reason about.
     */
    const spanStartMs = span ? (span.startAtMs ?? span.startMs) : null;
    const spanSpeed = span?.speed ?? null;
    const spanToken = span?.token ?? null;

    // Read when a span arrives rather than listed as a dependency: holding and letting go are
    // not arrivals, and re-running the seek on either would throw the playhead back to the in
    // point.
    const heldRef = useRef(held);
    const refusedRef = useRef(onPlayRefused);

    heldRef.current = held;
    refusedRef.current = onPlayRefused;

    const playOrReport = useCallback((video: HTMLVideoElement) => {
        void video.play().catch((error: unknown) => {
            announceRefusal(video, error);

            if (error instanceof DOMException && error.name === "NotAllowedError") {
                refusedRef.current?.();
            }
        });
    }, []);

    useEffect(() => {
        const video = videoEl;

        if (!video || spanStartMs === null) {
            return;
        }

        const start = () => {
            video.currentTime = spanStartMs / 1000;
            video.playbackRate = effectiveRate(spanSpeed, 1);

            /**
             * **Arriving at a span starts it.**
             *
             * Asking for a span is asking to watch it — there is no reading of "preview this
             * clip" or "play this reel" under which the right outcome is a playhead that moves
             * and a picture that does not. This used to seek and stop there, which looked like
             * the button having half worked.
             *
             * It is also what makes a reel continuous: the out point pauses, the next span
             * arrives, and this is the thing that starts it again.
             *
             * Allowed to fail, like every other `play()` here: the browser may refuse without a
             * gesture, and a refused preview is a paused video rather than a broken page -- and
             * a stage that needs to know is told.
             *
             * Not while held: the span is seeked and waits (§14g).
             */
            if (!heldRef.current) {
                playOrReport(video);
            }
        };

        if (video.readyState >= 1) {
            start();

            return;
        }

        video.addEventListener("loadedmetadata", start, { once: true });

        return () => video.removeEventListener("loadedmetadata", start);
    }, [videoEl, spanStartMs, spanSpeed, spanToken, playOrReport]);

    /**
     * Holding and letting go (§14g).
     *
     * Only once the element knows how long it is: before that, the span's arrival above is
     * still waiting for `loadedmetadata`, and it is the one that seeks and starts.
     */
    const hasSpan = spanStartMs !== null;

    useEffect(() => {
        const video = videoEl;

        if (!video || !hasSpan || video.readyState < 1) {
            return;
        }

        if (held) {
            video.pause();
        } else if (video.paused) {
            playOrReport(video);
        }
    }, [held, hasSpan, videoEl, playOrReport]);

    /**
     * Ending at the out point.
     *
     * Three layers, because `timeupdate` alone overshoots by up to a quarter of a second and the
     * overshoot lands on the join — see `useOutPoint`. Null outside reel mode, where the file's
     * own end is the end.
     */
    useOutPoint(videoEl, span, 1, () => onSpanEnded?.());

    /**
     * Playback state mirrored into React.
     *
     * The native controls are replaced rather than supplemented, because there is no way to
     * put a filmstrip above the browser's own scrubber: its geometry is not exposed, and it
     * differs per browser. Two scrubbers would be worse than one.
     */
    const [playing, setPlaying] = useState(false);
    const [positionMs, setPositionMs] = useState(0);

    // The browser keeps the screen on for a film with sound and not for a muted one (§14b).
    useScreenWakeLock(playing);

    /**
     * Holding the last frame of the span that just ended, until the next one can be seen (§14d).
     *
     * A join shows the wrong picture whenever the incoming element is **cold** — warming refused,
     * or the next file's metadata had not arrived in time, which a two-second opening clip and a
     * fifty-megabyte MP4 with its index at the end make ordinary. A cold element has no decoded
     * frame at all, so the browser paints the poster or black: the first frame of the next video,
     * before it has seeked anywhere.
     *
     * Keeping the *outgoing element* on screen instead is the obvious move and does not work. The
     * hidden slot is a one-pixel transparent box, and `assignSlots` empties it when there is
     * nothing worth warming — so the element that holds the frame we want is often unmounted by
     * the time the swap happens. What survives is a copy of its last frame, taken while it is
     * still there.
     *
     * One `drawImage` per join, from a same-origin element, so the canvas is not tainted and the
     * cost is a single blit at the one moment nothing else is happening.
     */
    const freezeRef_ = useRef<HTMLCanvasElement>(null);
    const [frozen, setFrozen] = useState(false);

    const freeze = useCallback(() => {
        const video = videoRef.current;
        const canvas = freezeRef_.current;
        const container = containerRef.current;

        // Nothing decoded means nothing worth holding, and a frozen blank is worse than a swap.
        if (!video || !canvas || !container || video.readyState < 2 || !video.videoWidth) {
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);

        /**
         * Sized to where the picture actually is, measured rather than assumed.
         *
         * The video is in normal flow above the control bar and letterboxed inside its own box;
         * the canvas is absolutely positioned in the player, so it has to be told. Measuring also
         * makes this correct in fullscreen, where the box is a different shape entirely.
         */
        const box = video.getBoundingClientRect();
        const frame = container.getBoundingClientRect();

        canvas.style.top = `${box.top - frame.top}px`;
        canvas.style.left = `${box.left - frame.left}px`;
        canvas.style.width = `${box.width}px`;
        canvas.style.height = `${box.height}px`;

        setFrozen(true);
    }, []);

    if (freezeRef) {
        freezeRef.current = freeze;
    }

    /**
     * Letting go, once the new span can actually be seen.
     *
     * "Seen" is a decoded frame **at the in point**, not merely a loaded file: `seeked` with
     * `readyState >= 2` is the first moment the element has something to show at the position it
     * was sent to. The timeout is the safety on it — a file that stalls must cost a join, not
     * leave a still frame standing in for a video for ever.
     */
    useEffect(() => {
        const video = videoEl;

        if (!frozen || !video) {
            return;
        }

        const targetMs = spanStartMs ?? 0;
        const ready = () =>
            video.readyState >= 2 &&
            !video.seeking &&
            video.videoWidth > 0 &&
            video.currentTime * 1000 >= targetMs - 100;

        if (ready()) {
            setFrozen(false);

            return;
        }

        const check = () => {
            if (ready()) {
                setFrozen(false);
            }
        };

        const events = ["loadeddata", "seeked", "canplay", "playing", "timeupdate"];

        events.forEach((event) => video.addEventListener(event, check));

        const bail = setTimeout(() => setFrozen(false), FREEZE_LIMIT_MS);

        return () => {
            events.forEach((event) => video.removeEventListener(event, check));
            clearTimeout(bail);
        };
    }, [frozen, videoEl, spanStartMs, spanToken]);

    /**
     * Where the reel has got to, when the bar is measuring one.
     *
     * What has run before this span, plus how far into this span the playhead is — in **run
     * time**, so a half-speed span contributes the twenty seconds it takes to watch rather than
     * the ten seconds of source it covers. Clamped to the span so a position outside it, which a
     * moment of buffering or a swap can produce, cannot push the bar past the end or behind the
     * start.
     */
    const reelPositionMs = timeline
        ? timeline.offsetMs +
          spanRunMs({
              startMs: span?.startMs ?? 0,
              endMs: Math.min(Math.max(positionMs, span?.startMs ?? 0), span?.endMs ?? positionMs),
              speed: span?.speed ?? null,
          })
        : positionMs;

    const [bufferedMs, setBufferedMs] = useState(0);
    const [muted, setMuted] = useState(false);
    const [, rememberMuted] = usePlaybackPref("muted");
    const [speed, setSpeed] = useState("1");
    /** Which page of the "more" menu is showing: its actions, or the speeds (phone only). */
    const [moreView, setMoreView] = useState<"actions" | "speed">("actions");

    /**
     * A phone: the bar keeps the transport, fullscreen and the set, and the rest goes into the
     * "more" menu. Seven targets of 44px are what fits across a 400px portrait screen.
     */
    const compact = useMediaQuery("(max-width: 48em)") ?? false;
    /** A finger rather than a pointer: every target in the bar stands 44px (CLAUDE.md). */
    const coarse = useMediaQuery("(pointer: coarse)") ?? false;
    const iconSize = coarse ? "xl" : "lg";
    const [scrubbing, setScrubbing] = useState(false);
    const [mediaDurationMs, setMediaDurationMs] = useState(durationMs ?? 0);

    // Keeps the scrubber from fighting the drag: `timeupdate` fires while seeking, and
    // applying it would snap the handle back to wherever playback currently is.
    const scrubbingRef = useRef(false);
    scrubbingRef.current = scrubbing;

    /**
     * The latest place asked for while the element was still seeking, or null (`seekTo`).
     *
     * Read by `onTime` too: until it is applied, the element's own position is a stale target
     * and drawing it would snap the handle back for the length of one seek.
     */
    const pendingSeekRef = useRef<number | null>(null);

    /**
     * Whether the bar has been left alone long enough to go (§14).
     *
     * Fullscreen only — in the page the bar sits under the picture and covers nothing. What
     * holds it open is everything that means the viewer is still using it: a paused video,
     * which is a decision rather than an idle moment; a scrub in progress; the pointer resting
     * on the bar; a menu in it while it is open; and a viewer walking the controls by
     * keyboard, who has not moved the pointer and would otherwise lose the button under them.
     *
     * **Focus alone is not use.** Reading `bar.contains(activeElement)` was, and it meant that
     * entering fullscreen from the button in the bar wedged the bar open for the rest of the
     * item: a click leaves focus on the button it pressed, and the very click that gives the
     * viewer the whole screen is the one that leaves a strip of controls across the bottom of
     * it until they happen to move focus off. So the focus that holds the bar is keyboard
     * focus, which is `:focus-visible` — the browser's own reading of the same distinction,
     * rather than a modality flag of ours that would have to be right about every input device.
     *
     * The bar's menus are asked separately, by `data-expanded` on their targets, because a menu
     * opens on a click and the focus it leaves behind is the kind we now ignore.
     *
     * **Hover is a pointer resting, not a finger that tapped.** Reading `:hover` was, and on a
     * tablet it wedged the bar open for good: a touch browser leaves `:hover` on whatever was
     * last tapped until something else is, so the tap on the fullscreen button -- in the bar --
     * made the bar "hovered" for the rest of the item. Tracked from pointer events instead, with
     * touch left out; a mouse or a hovering pen still holds it.
     */
    const barHoveredRef = useRef(false);

    const controlsIdle = useIdleControls(isFullscreen && !bare, () => {
        const bar = barRef.current;

        return (
            !playing ||
            scrubbingRef.current ||
            barHoveredRef.current ||
            (bar !== null &&
                (bar.querySelector("[data-expanded]") !== null ||
                    bar.querySelector(":focus-visible") !== null))
        );
    });

    /**
     * Track everything the control bar renders.
     *
     * Bound to the element rather than driven by our own calls, so the UI stays correct when
     * something else changes playback — a hotkey, a media-key on the keyboard, or the OS.
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onTime = () => {
            // Written even mid-scrub: capturing the frame under the scrubber is a reasonable
            // thing to want, and the playhead is where it is regardless of what the control
            // bar is allowed to redraw.
            if (positionRef) {
                positionRef.current = video.currentTime * 1000;
            }

            if (!scrubbingRef.current && pendingSeekRef.current === null) {
                setPositionMs(video.currentTime * 1000);
            }

            if (video.buffered.length > 0) {
                setBufferedMs(video.buffered.end(video.buffered.length - 1) * 1000);
            }
        };

        const onDuration = () => {
            // The probe's duration can be wrong or missing; the decoder's is authoritative.
            if (Number.isFinite(video.duration) && video.duration > 0) {
                setMediaDurationMs(video.duration * 1000);
            }
        };

        const onCanPlay = () => setSettled(true);
        const onPlay = () => setPlaying(true);
        const onPauseState = () => setPlaying(false);
        const onRate = () => setSpeed(String(video.playbackRate));
        /**
         * Silence is a preference, so it outlives the video (§14b).
         *
         * Written from the element's own event rather than from the mute button, because the
         * keyboard (`m`) and the button are two ways to the same change and the element is
         * where they meet.
         */
        const onVolume = () => {
            setMuted(video.muted);
            rememberMuted(video.muted);
        };

        video.addEventListener("timeupdate", onTime);
        video.addEventListener("progress", onTime);
        video.addEventListener("seeking", onTime);
        video.addEventListener("loadedmetadata", onDuration);
        video.addEventListener("durationchange", onDuration);
        video.addEventListener("canplay", onCanPlay);
        video.addEventListener("play", onPlay);
        video.addEventListener("pause", onPauseState);
        video.addEventListener("ratechange", onRate);
        video.addEventListener("volumechange", onVolume);

        /**
         * Read the element once, now, rather than waiting for it to say something.
         *
         * A warmed element has **already** fired `loadedmetadata` and a run of `progress`
         * before it ever appeared on screen, and an element fires nothing at all just for
         * being watched. Without this the control bar would show a duration of zero and an
         * empty buffer under a video that is ready to play, until the first `timeupdate` —
         * which, for a paused item, never comes.
         */
        onDuration();
        onTime();
        onRate();
        setPlaying(!video.paused);

        // HAVE_FUTURE_DATA. A warmed element reached it before anybody looked at it, so the
        // event that would have said so is in the past.
        if (video.readyState >= 3) {
            setSettled(true);
        }

        return () => {
            video.removeEventListener("timeupdate", onTime);
            video.removeEventListener("progress", onTime);
            video.removeEventListener("seeking", onTime);
            video.removeEventListener("loadedmetadata", onDuration);
            video.removeEventListener("durationchange", onDuration);
            video.removeEventListener("canplay", onCanPlay);
            video.removeEventListener("play", onPlay);
            video.removeEventListener("pause", onPauseState);
            video.removeEventListener("ratechange", onRate);
            video.removeEventListener("volumechange", onVolume);
        };
        // `positionRef` is a ref object and so stable for the life of the page; it is listed
        // because it is read inside, not because this is expected to re-run. `videoEl` is the
        // one that matters: the element is reused across items now, and replaced when the next
        // item was warmed in advance, so this has to follow it.
    }, [videoEl, positionRef, rememberMuted]);

    /**
     * Carry the stored mute onto each item (§14b).
     *
     * Read here rather than taken from the hook's state: `usePlaybackPref` reads after mount,
     * so its first value is always the default, and a video that autoplays in that gap would
     * be briefly audible to somebody who had asked for silence.
     *
     * Keyed on the item, because the element is reused as you step through a set — without
     * this, mute would apply to the video you muted and to nothing after it.
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        video.muted = readPlaybackPref("muted");
        setMuted(video.muted);
    }, [mediaId]);

    /**
     * A mute that belongs to the stage around the player (§14g).
     *
     * Declared after the stored preference above so that on an arrival it has the last word;
     * the element's own `volumechange` then writes it back to the preference, as the player's
     * button does.
     */
    useEffect(() => {
        const video = videoEl;

        if (!video || mutedProp === undefined) return;

        video.muted = mutedProp;
    }, [mutedProp, videoEl, mediaId]);

    /**
     * Seek, with at most one seek in flight.
     *
     * A seek that lands outside what is buffered is a new range request, and a mouse dragging
     * the scrubber asks for one per `pointermove`. Each later target replaces the last while the
     * element is busy, and only the newest is applied when it finishes -- so a drag costs one
     * request per seek the NAS can actually answer, rather than one per pixel (§9).
     */
    const seekTo = useCallback((ms: number) => {
        const video = videoRef.current;
        if (!video) return;

        setPositionMs(ms);

        if (video.seeking) {
            pendingSeekRef.current = ms;

            return;
        }

        video.currentTime = ms / 1000;
    }, []);

    useEffect(() => {
        const video = videoEl;
        if (!video) return;

        const onSeeked = () => {
            const pending = pendingSeekRef.current;

            if (pending === null) return;

            pendingSeekRef.current = null;
            video.currentTime = pending / 1000;
        };

        video.addEventListener("seeked", onSeeked);

        return () => {
            video.removeEventListener("seeked", onSeeked);
            // A target meant for the element being left is not one for the next.
            pendingSeekRef.current = null;
        };
    }, [videoEl]);

    if (seekRef) {
        seekRef.current = seekTo;
    }

    if (elementRef) {
        elementRef.current = videoEl;
    }

    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        /**
         * At the end of a reel the transport means "again", not "resume".
         *
         * Resuming here would start the underlying file at the last span's out point and run on
         * through the rest of it, which is what it used to do. `outPoint.ts` refuses that on its
         * own now; this is what makes the button do the useful thing instead of nothing.
         */
        if (atEnd && onReplay) {
            onReplay();

            return;
        }

        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
    }, [atEnd, onReplay]);

    /**
     * Tell the server about a view that counted: the watched threshold, or the end (§14b).
     *
     * Reel mode records nothing, and the gate is here rather than at each of the callers so that
     * a new one cannot forget it (§14d). Watching twelve seconds of a film inside somebody's
     * highlight reel is not a statement about that film, and it certainly should not mark it
     * watched.
     */
    const reportView = useCallback(
        (finished: boolean, watched?: true) => {
            if (!reportProgress) {
                return;
            }

            // `keepalive` so the end of an item survives the page being closed on it.
            void api(`/api/media/${mediaId}/progress`, {
                method: "PUT",
                body: JSON.stringify({ finished, ...(watched ? { watched } : {}) }),
                keepalive: true,
            }).catch(() => {
                // A convenience; a failed save must never interrupt playback.
            });
        },
        [mediaId, reportProgress]
    );

    /**
     * Remember where `video` was left, for coming back to it this visit (`lib/resumePoint.ts`).
     *
     * Takes the element rather than a position because the caller, leaving an item, holds the
     * element that item played in, while `videoRef` may already be the warmed one that replaced
     * it (§8b). Gated as `reportView` is, for the same reason.
     */
    const keepPosition = useCallback(
        (video: HTMLVideoElement) => {
            if (reportProgress) {
                rememberPosition(mediaId, Math.floor(video.currentTime * 1000));
            }
        },
        [mediaId, reportProgress]
    );

    /**
     * Thirty seconds of *uninterrupted* playback marks the item watched (§14b).
     *
     * Uninterrupted is why this is counted here rather than inferred from a position. A
     * position says nothing about how it was reached: scrubbing to 00:31 and stopping would look
     * identical to watching the first half minute. The run is accumulated from the element's own
     * clock and reset whenever the viewer seeks, which is the only place that distinction exists.
     *
     * The threshold is `min(30s, 90% of duration)`. The short-item clause is not a detail:
     * without it nothing under thirty seconds could ever be marked watched, and a library of
     * short clips would carry a feature that silently never applied to it.
     *
     * Announced at most once per mount. The server sets only when unset, so a repeat would
     * be harmless rather than wrong — this keeps it off the wire at all.
     */
    const watchedRunRef = useRef(0);
    const lastTickRef = useRef<number | null>(null);
    const announcedRef = useRef(false);

    /**
     * Whether the opening seek has been decided on this arrival at this item.
     *
     * A warmed element has its metadata before it is ever shown, so the `loadedmetadata`
     * listener the seek used to hang on has already fired and will not fire again. Seeking
     * immediately in that case is the fix, and this is what keeps the fix from becoming a bug:
     * the seek's effect re-runs whenever the item's details are refetched while you watch, and
     * seeking again would drag the playhead back to where you came in.
     *
     * Cleared by the reset below rather than remembered per id, which is not the same thing:
     * stepping back to the item you just left is a new arrival at it, and it has a position to
     * return to precisely *because* you were there a moment ago.
     */
    const resumeAppliedRef = useRef(false);

    /**
     * The probe's duration, readable from an effect that must not re-run when it changes.
     *
     * The details are refetched while you watch — a rating, a progress save, a live update —
     * and the reset below must not fire again in the middle of an item just because a number
     * it uses as a fallback arrived a second time.
     */
    const durationPropRef = useRef(durationMs);

    durationPropRef.current = durationMs;

    /**
     * Start of a new item, on an element that may or may not be new (§8b).
     *
     * This used to be free. Every item got a fresh mount — the page blanked to a loader while
     * its details loaded, which threw the player away — so every counter here started at zero
     * because it had just been constructed. Now the element survives the change of item, and a
     * warmed one arrives already loaded, so "what is true of this item" has to be said out
     * loud: without it the control bar would show the previous item's duration and the
     * thirty-second watched counter would carry across a set.
     *
     * Everything is read back off the element rather than assumed, because the element may
     * already be several seconds into being ready.
     */
    useEffect(() => {
        const video = videoRef.current;

        watchedRunRef.current = 0;
        lastTickRef.current = null;
        announcedRef.current = false;
        resumeAppliedRef.current = false;
        // No `failed` to clear: giving up is recorded against the id it happened to, so a new
        // arrival is already not reported.
        setScrubbing(false);

        if (positionRef) {
            positionRef.current = 0;
        }

        if (!video) {
            setSettled(false);
            return;
        }

        /**
         * The rate is the item's, not the set's, which is what a fresh element used to give
         * for nothing. Applied to the element as well as to the control, because a reused
         * element is still running at whatever was chosen for the item before it.
         */
        video.playbackRate = 1;
        setSpeed("1");

        /**
         * Read back rather than assumed false, and this is the order that makes it matter: the
         * effect that binds the listeners is declared above this one, so on a warmed swap it
         * has already reported the element ready by the time this runs. A flat `false` here
         * would erase that, and the event that would have said so again is in the past — so the
         * item after next would never be warmed at all.
         */
        setSettled(video.readyState >= 3);
        setPlaying(!video.paused);
        setPositionMs(video.currentTime * 1000);
        setBufferedMs(
            video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) * 1000 : 0
        );
        setMediaDurationMs(
            Number.isFinite(video.duration) && video.duration > 0
                ? video.duration * 1000
                : (durationPropRef.current ?? 0)
        );
    }, [mediaId, videoEl, positionRef]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onTick = () => {
            if (announcedRef.current || video.paused) {
                lastTickRef.current = null;
                return;
            }

            const now = video.currentTime * 1000;
            const previous = lastTickRef.current;
            lastTickRef.current = now;

            if (previous === null) return;

            const advanced = now - previous;

            /**
             * Only forward motion, and only at something like real speed.
             *
             * A backward step is a seek the `seeking` handler may not have reset yet; a
             * jump far larger than the tick interval is a seek forward wearing the shape of
             * playback. Both would otherwise let scrubbing accumulate a "watched" run. The
             * ceiling is generous enough for 4× playback and a slow `timeupdate`.
             */
            if (advanced <= 0 || advanced > 4000) return;

            watchedRunRef.current += advanced;

            const duration = (video.duration || 0) * 1000;
            const threshold =
                duration > 0 ? Math.min(WATCHED_AFTER_MS, duration * 0.9) : WATCHED_AFTER_MS;

            if (watchedRunRef.current >= threshold) {
                announcedRef.current = true;
                reportView(false, true);
            }
        };

        // A seek is the interruption. The run starts again from wherever they landed.
        const onSeeking = () => {
            watchedRunRef.current = 0;
            lastTickRef.current = null;
        };

        video.addEventListener("timeupdate", onTick);
        video.addEventListener("seeking", onSeeking);
        video.addEventListener("pause", onSeeking);

        return () => {
            video.removeEventListener("timeupdate", onTick);
            video.removeEventListener("seeking", onSeeking);
            video.removeEventListener("pause", onSeeking);
        };
    }, [reportView]);

    /**
     * Return to where the item was left earlier in this visit, if it was.
     *
     * The rule itself lives in `lib/resumePoint.ts`, because the page asks it too — what gets
     * warmed has to be the part that will be played, and a warm from zero followed by a seek to
     * 4:32 is bandwidth spent on the wrong part of the file (§8b).
     *
     * An address that names a moment (`?at=`, from the Captures page) wins over it, through the
     * same once-per-arrival guard.
     */
    useEffect(() => {
        const video = videoRef.current;

        // Once per arrival. See `resumeAppliedRef`: this effect re-runs whenever the details
        // are refetched, and the second run must not move a playhead somebody has since moved.
        if (!video || resumeAppliedRef.current) {
            return;
        }

        const target = openingTarget(
            startAtMs,
            reportProgress ? visitPosition(mediaId) : null,
            durationMs
        );

        if (target === null) {
            resumeAppliedRef.current = true;
            return;
        }

        const onLoaded = () => {
            resumeAppliedRef.current = true;
            video.currentTime = target / 1000;
        };

        /**
         * A warmed element is past this event already (§8b). `readyState >= 1` is "we know the
         * duration", which is exactly when a seek is legal — so the two paths are the same seek
         * and differ only in whether it can happen now or has to wait.
         */
        if (video.readyState >= 1) {
            onLoaded();
            return;
        }

        video.addEventListener("loadedmetadata", onLoaded, { once: true });

        return () => video.removeEventListener("loadedmetadata", onLoaded);
    }, [mediaId, videoEl, startAtMs, durationMs, reportProgress]);

    /**
     * Play on arrival, once, if this device asks for it.
     *
     * After `loadedmetadata` so the opening seek above has already landed — starting first
     * would play a second of the opening before jumping to where you left off. `play()`
     * returns a promise that rejects when the browser refuses, and that rejection is
     * swallowed on purpose: refusing is a legitimate outcome here, not an error, and the
     * player is left paused exactly as if nobody had asked.
     *
     * **The preference is read when the moment comes, not when the item arrives.** The page's
     * `usePlaybackPref` reads storage after mount, so a player mounted in the same commit as the
     * page -- stepping to an item whose details were already prefetched -- sees the default,
     * `true`. Checked at arrival, that armed a `loadedmetadata` listener which the stored `false`
     * landing one effect later could not disarm, and "Play on open" switched off still played
     * every item reached with n.
     */
    const autoPlayRef = useRef(autoPlay);

    autoPlayRef.current = autoPlay;

    useEffect(() => {
        const video = videoRef.current;

        if (!video) return;

        const start = () => {
            if (!autoPlayRef.current) return;

            void video.play().catch((error: unknown) => announceRefusal(video, error));
        };

        if (video.readyState >= 1) {
            start();
            return;
        }

        video.addEventListener("loadedmetadata", start, { once: true });

        return () => video.removeEventListener("loadedmetadata", start);
        // Deliberately only on mount and on the item changing, with `autoPlay` read through the
        // ref: re-running when it is toggled would restart the video someone has just paused.
    }, [mediaId]);

    /** Telling the page the item finished, so it can decide whether to roll onward. */
    useEffect(() => {
        const video = videoRef.current;

        if (!video || !onEnded) return;

        video.addEventListener("ended", onEnded);

        return () => video.removeEventListener("ended", onEnded);
        // `videoEl` because the element is replaced by a warmed one on a swap, and a listener
        // left on the old element would never hear this item end.
    }, [onEnded, videoEl]);

    /** A view, at the end (§14b). */
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const onEnded = () => reportView(true);

        video.addEventListener("ended", onEnded);

        return () => video.removeEventListener("ended", onEnded);
        // `videoEl` because the element is replaced by a warmed one on a swap, as for `onEnded`.
    }, [reportView, videoEl]);

    /**
     * Where the item was left, on leaving it.
     *
     * Kept apart from the listener above because it must not follow the element: rebinding to a
     * warmed element is not leaving anything. It runs when the item changes or the player goes,
     * with the element captured when the item arrived — by the time this runs `videoRef` may
     * already hold the next item's.
     *
     * Only on leaving, because nothing else needs it: the position lives in this page, so closing
     * the tab takes it along, and a hidden tab keeps it.
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        return () => keepPosition(video);
    }, [keepPosition]);

    /**
     * Keyboard control (§14).
     *
     * Bound to the document rather than the video element, because the element only has
     * focus after a click and a viewer expects space to work the moment the page opens.
     * Typing in an input must not seek, hence the target check.
     *
     * ```
     * space / k   play, pause          , .     frame back, forward (paused)
     * j / l       back, forward 10s    - / +   slower, faster
     * ← / →       back, forward 5s     m       mute
     * shift ← →   30s                  f       fullscreen
     * 1 … 9 0     jump to 10 … 90, 0%  s       capture this frame
     * ```
     *
     * The digits are the **number row**, matched on `event.code`. The numpad rates the item
     * instead, on the page rather than here (§14b), and the two are only distinguishable by
     * code: `event.key` is "3" for both, so binding by key gave one keystroke two jobs.
     */
    /**
     * Read inside the handler rather than closed over, so the handler is registered once.
     *
     * Rebinding on every render would drop and re-add a document listener four times a
     * second while the video plays, which is both wasteful and a way to lose a keypress.
     */
    const hotkeysRef = useRef(hotkeys);
    // A bare player's keys are its stage's (§14g).
    hotkeysRef.current = hotkeys && !bare;

    // Same reason: the key handler is bound once, and this changes identity every render.
    const fullscreenRef = useRef(toggleFullscreen);
    fullscreenRef.current = toggleFullscreen;

    const onCaptureRef = useRef(onCapture);
    onCaptureRef.current = onCapture;

    /**
     * The one place a player position becomes a capture position.
     *
     * `HTMLMediaElement.currentTime` is **seconds** and `onCapture` takes **milliseconds**,
     * and that conversion used to be written out at each of the two call sites. The button
     * was missing it, so pressing it at 0:03 asked for 3ms and saved the first frame of the
     * video — a wrong answer that looks like a right one, since it is a real frame of the
     * right file and nothing errors. The hotkey, written second, had it.
     *
     * Neither the schema nor the service can catch this: 3 is a perfectly good position in
     * a video that is longer than 3ms. So the conversion happens once, here, and the two
     * controls call the same function rather than each doing their own arithmetic.
     */
    const captureHere = useCallback(() => {
        const video = videoRef.current;

        if (video) {
            onCaptureRef.current?.(video.currentTime * 1000);
        }
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const video = videoRef.current;
            if (!video) return;

            // Something is open over the player and the keyboard is its business.
            if (!hotkeysRef.current) {
                return;
            }

            // Typing, not every form control: a star rating is a radio, and blocking on the
            // tag name alone made the keys go quiet the moment somebody clicked one.
            if (isTypingTarget(event.target)) {
                return;
            }

            const step = event.shiftKey ? 30 : 5;

            switch (event.key) {
                case " ":
                case "k":
                    event.preventDefault();
                    if (video.paused) void video.play();
                    else video.pause();
                    break;
                case "ArrowLeft":
                    event.preventDefault();
                    video.currentTime = Math.max(0, video.currentTime - step);
                    break;
                case "ArrowRight":
                    event.preventDefault();
                    video.currentTime = Math.min(video.duration || 0, video.currentTime + step);
                    break;
                case "j":
                    video.currentTime = Math.max(0, video.currentTime - 10);
                    break;
                case "l":
                    video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
                    break;
                case ",":
                    // Frame stepping only makes sense while paused.
                    if (video.paused) video.currentTime -= 1 / 30;
                    break;
                case ".":
                    if (video.paused) video.currentTime += 1 / 30;
                    break;
                case "m":
                    video.muted = !video.muted;
                    break;
                case "s":
                    /**
                     * Capture the frame on screen.
                     *
                     * `s` is what mpv uses for a screenshot. `c` is the better mnemonic and
                     * is deliberately left alone: web players overwhelmingly bind it to
                     * captions, `subtitleVtt` is already an artifact kind, and a key people
                     * have learned is a bad thing to need back later.
                     */
                    event.preventDefault();
                    captureHere();
                    break;
                case "[":
                    /**
                     * Mark the in point, and the out point, of a clip (§14d).
                     *
                     * Reserved in §14's keymap long before there was anything to bind them to.
                     * They sit next to each other, which is the gesture: watch to the start of
                     * the good bit, press `[`, watch to the end of it, press `]`.
                     *
                     * The player reports the position and nothing else. What a selection *is*
                     * belongs to the page, because a saved clip is a row about the item rather
                     * than a fact about playback — the same split `onCapture` uses.
                     */
                    event.preventDefault();
                    onMarkIn?.(video.currentTime * 1000);
                    break;
                case "]":
                    event.preventDefault();
                    onMarkOut?.(video.currentTime * 1000);
                    break;
                case "f":
                    // The container rather than the video, so our control bar comes with it,
                    // and through the hook, so the next item keeps the screen (§14b).
                    fullscreenRef.current();
                    break;
                case "-":
                case "_":
                    // Quarters, and below a quarter the one slower step the menu offers.
                    video.playbackRate =
                        video.playbackRate <= 0.25
                            ? MIN_RATE
                            : Math.max(0.25, video.playbackRate - 0.25);
                    break;
                case "+":
                case "=":
                    video.playbackRate =
                        video.playbackRate < 0.25 ? 0.25 : Math.min(4, video.playbackRate + 0.25);
                    break;
                default: {
                    /**
                     * The number row jumps to 0–90% of the duration.
                     *
                     * Matched on `code` rather than `key`, which is the whole of the fix: the
                     * numpad produces the same `key` as the row above the letters, so every
                     * one of these was also a numpad key — and the numpad now rates the item
                     * instead (§14b). Pressing Numpad3 to give three stars would have seeked
                     * to 30% as well, in the same keystroke.
                     *
                     * `code` also reads the physical key rather than what the layout makes
                     * of it, so this keeps working where the digits need a modifier.
                     */
                    const digit = /^Digit([0-9])$/.exec(event.code);

                    if (digit && video.duration) {
                        video.currentTime = (video.duration * Number(digit[1])) / 10;
                    }

                    break;
                }
            }
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
        // `captureHere` is stable, so listing it re-binds nothing and keeps the one
        // conversion from being inlined back into this handler.
    }, [captureHere, onMarkIn, onMarkOut]);

    /**
     * Touch: double-tap the left or right third to seek.
     *
     * Implemented on the container rather than fighting the native controls, and only in the
     * outer thirds so a double-tap in the middle still reaches the play button.
     */
    const lastTapRef = useRef<{ time: number; x: number } | null>(null);

    const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
        const video = videoRef.current;
        if (!video) return;

        const touch = event.changedTouches[0];
        if (!touch) return;

        const now = Date.now();
        const previous = lastTapRef.current;
        lastTapRef.current = { time: now, x: touch.clientX };

        if (!previous || now - previous.time > 300 || Math.abs(touch.clientX - previous.x) > 40) {
            return;
        }

        const bounds = event.currentTarget.getBoundingClientRect();
        const relative = (touch.clientX - bounds.left) / bounds.width;

        if (relative < 0.33) {
            video.currentTime = Math.max(0, video.currentTime - 10);
        } else if (relative > 0.67) {
            video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        }
    };

    const scrubber = (
        <SpriteScrubber
            vttUrl={spriteVttUrl}
            durationMs={timeline ? timeline.totalMs : mediaDurationMs}
            positionMs={timeline ? reelPositionMs : positionMs}
            /* Nothing meaningful to say about buffering against a reel's timeline: the spans
               after this one are in files the element has not opened. */
            bufferedMs={timeline ? 0 : bufferedMs}
            clips={timeline ? [] : clipMarks}
            selection={timeline ? null : selection}
            onSeek={timeline ? timeline.onSeek : seekTo}
            onScrubbingChange={timeline ? undefined : setScrubbing}
        />
    );

    const toggleMute = () => {
        const video = videoRef.current;
        if (video) video.muted = !video.muted;
    };

    const speedLabel = `${Number(speed)}×`;
    const speedItems = SPEEDS.map((rate) => (
        <Menu.Item
            key={rate}
            onClick={() => {
                const video = videoRef.current;
                if (video) video.playbackRate = Number(rate);
            }}
            rightSection={Number(rate) === Number(speed) ? <CheckGlyph size={16} /> : null}
        >
            {rate}×
        </Menu.Item>
    ));

    /** One control for both ends of a clip: the start, then -- past it -- the end (§14d). */
    const clipPending = selection !== null && selection.endMs === null;
    const markLabel = clipPending ? "Mark the clip's end (])" : "Mark a clip's start ([)";
    const markClip =
        onMarkIn && !timeline
            ? () => {
                  const video = videoRef.current;

                  if (!video) return;

                  const at = video.currentTime * 1000;

                  if (selection && selection.endMs === null && at > selection.startMs) {
                      onMarkOut?.(at);
                  } else {
                      onMarkIn(at);
                  }
              }
            : null;

    return (
        <Box
            ref={attachContainer}
            onTouchEnd={bare ? undefined : onTouchEnd}
            className={classes.player}
            // The whole window, laid over the page rather than handed to this element: what
            // the browser is showing full screen is the document, so that the next item
            // inherits it (§14b, `usePlayerFullscreen`). Never when bare: the stage around it
            // already fills the screen, and this would lift the player over that stage.
            data-fullscreen={(isFullscreen && !bare) || undefined}
            data-bare={bare || undefined}
            data-fit={bare && fit === "cover" ? "cover" : undefined}
            // The pointer goes with the bar: a cursor sitting over a film is the same
            // interruption the bar was, and every player people know hides both together.
            data-idle={controlsIdle || undefined}
        >
            {/*
             * Two elements, one of them playing (§8b).
             *
             * Keyed by the id they hold and never reordered, which is what lets the element
             * that was warming become the element that is playing: React reuses a node whose
             * key stayed put, and a `<video>` that is neither rebuilt nor moved in the DOM
             * keeps the picture it has already buffered. Reordering them so the playing one
             * came first would throw that away for the sake of source order nobody sees.
             *
             * The hidden one gets no ref, no handlers and no poster: it is a download with a
             * decoder attached, and every event it fires belongs to an item nobody is watching.
             */}
            {/*
             * The held frame, over the picture and under nothing.
             *
             * `hidden` rather than unmounted so the canvas keeps its bitmap between joins: it is
             * drawn into at the moment the outgoing element still has a frame, which is one tick
             * before the element that had it may cease to exist.
             */}
            <canvas ref={freezeRef_} className={classes.freeze} hidden={!frozen} aria-hidden />

            {slots.ids.map((slotId, index) => {
                if (slotId === null) return null;

                const live = index === slots.active;

                return (
                    <ReleasingVideo
                        key={slotId}
                        ref={live ? attach : attachWarming}
                        src={`/api/media/${slotId}/stream`}
                        poster={live ? (poster ?? undefined) : undefined}
                        /* The one that lights the room, and only ever the live one: the warming
                           element holds a video nobody is watching (§14b, `useSpillLight`). */
                        data-spill={live || undefined}
                        playsInline
                        muted={!live}
                        /* `auto` on the hidden one is the whole point: buffer it, do not merely
                           ask how long it is. How much the browser asks for is still its
                           decision; how much it gets per request is not — an open-ended range
                           is bounded server-side, which is what stops a warm of the next item
                           draining a whole film through the web process (§8, `byteRange.ts`). */
                        /* A bare player's live element is often a cued one, held on its in point
                           for its turn (§14g) -- and "metadata" would leave it holding a frame
                           and nothing after it. */
                        preload={live && !bare ? "metadata" : "auto"}
                        onClick={live && !bare ? togglePlay : undefined}
                        onError={live ? reportUnplayable : undefined}
                        /* A refusal that raises no error: a browser that can decode the sound
                           but not the picture -- HEVC without a decoder for it -- plays the
                           one and drops the other, and the film is a black frame with a
                           soundtrack. No picture at all is the one sign of it (§8). */
                        onLoadedMetadata={
                            live
                                ? (event) => {
                                      if (event.currentTarget.videoWidth === 0) {
                                          reportUnplayable();
                                      }
                                  }
                                : undefined
                        }
                        aria-hidden={live ? undefined : true}
                        tabIndex={live ? undefined : -1}
                        className={live ? classes.video : classes.warming}
                    />
                );
            })}

            {!bare && (
                <Box
                    ref={barRef}
                    px="sm"
                    pb="xs"
                    className={classes.controls}
                    data-hidden={controlsIdle || undefined}
                    onPointerEnter={(event) => {
                        barHoveredRef.current = event.pointerType !== "touch";
                    }}
                    onPointerLeave={() => {
                        barHoveredRef.current = false;
                    }}
                >
                    {compact ? (
                        /* On a phone the time reads off the ends of the scrubber, which leaves the
                           row below it to the targets. */
                        <Group gap="xs" wrap="nowrap" align="center">
                            <Text size="xs" c="dimmed" className={classes.time}>
                                {formatTime(timeline ? reelPositionMs : positionMs)}
                            </Text>
                            <Box className={classes.scrubberSlot}>{scrubber}</Box>
                            <Text size="xs" c="dimmed" className={classes.time}>
                                {formatTime(timeline ? timeline.totalMs : mediaDurationMs)}
                            </Text>
                        </Group>
                    ) : (
                        scrubber
                    )}

                    <Group gap={compact ? 4 : "xs"} wrap="nowrap" align="center">
                        {steps && (
                            <ActionIcon
                                variant="subtle"
                                color="brass"
                                size={iconSize}
                                className={classes.step}
                                disabled={!steps.previous}
                                onClick={steps.previous ?? undefined}
                                aria-label="Previous item (p)"
                                title="Previous item (p)"
                            >
                                <PreviousGlyph />
                            </ActionIcon>
                        )}

                        <ActionIcon
                            variant="subtle"
                            color="brass"
                            size={iconSize}
                            onClick={() => {
                                // A reel seeks in reel time, so going back can cross into the
                                // previous span rather than stopping at this one's start.
                                if (timeline) {
                                    timeline.onSeek(Math.max(0, reelPositionMs - 10_000));

                                    return;
                                }

                                const video = videoRef.current;
                                if (video) seekTo(Math.max(0, video.currentTime * 1000 - 10_000));
                            }}
                            aria-label="Back 10 seconds (j)"
                        >
                            <BackTenGlyph />
                        </ActionIcon>

                        {/* Play between the two jumps, so the button that leaves the item is
                            never the one beside it. */}
                        <ActionIcon
                            variant="subtle"
                            color="brass"
                            size={iconSize}
                            onClick={togglePlay}
                            aria-label={atEnd ? "Play again" : playing ? "Pause" : "Play"}
                        >
                            {atEnd ? <ReplayGlyph /> : playing ? <PauseGlyph /> : <PlayGlyph />}
                        </ActionIcon>

                        <ActionIcon
                            variant="subtle"
                            color="brass"
                            size={iconSize}
                            onClick={() => {
                                // In reel time too, so it can cross into the next span.
                                if (timeline) {
                                    timeline.onSeek(
                                        Math.min(timeline.totalMs, reelPositionMs + 10_000)
                                    );

                                    return;
                                }

                                const video = videoRef.current;
                                if (video) {
                                    seekTo(
                                        Math.min(
                                            (video.duration || 0) * 1000,
                                            video.currentTime * 1000 + 10_000
                                        )
                                    );
                                }
                            }}
                            aria-label="Forward 10 seconds (l)"
                        >
                            <ForwardTenGlyph />
                        </ActionIcon>

                        {steps && (
                            <ActionIcon
                                variant="subtle"
                                color="brass"
                                size={iconSize}
                                className={classes.step}
                                disabled={!steps.next}
                                onClick={steps.next ?? undefined}
                                aria-label="Next item (n)"
                                title="Next item (n)"
                            >
                                <NextGlyph />
                            </ActionIcon>
                        )}

                        {!compact && (
                            <Text size="xs" c="dimmed" className={classes.time}>
                                {formatTime(timeline ? reelPositionMs : positionMs)} /{" "}
                                {formatTime(timeline ? timeline.totalMs : mediaDurationMs)}
                            </Text>
                        )}

                        <Box style={{ flex: 1 }} />

                        {/* Capturing belongs with the picture, not under it (§13). The title
                        row below the player is off-screen at ordinary window heights, which
                        made the most immediate action on the page the hardest to reach. */}
                        {/* Marking a clip, from the bar as well as `[` and `]` (§14d). The keys
                            were the only way in, and nothing on the page said they existed.
                            One button for both ends: it marks the start, and once a start is
                            marked and the playhead is past it, the end. */}
                        {!compact && markClip && (
                            <ActionIcon
                                variant="subtle"
                                color={clipPending ? "brass" : "gray"}
                                size={iconSize}
                                onClick={markClip}
                                aria-label={markLabel}
                                title={markLabel}
                            >
                                <ScissorsGlyph />
                            </ActionIcon>
                        )}

                        {!compact && onCapture && (
                            <ActionIcon
                                variant="subtle"
                                color={captureFailed ? "oxblood" : "brass"}
                                size={iconSize}
                                loading={capturing}
                                onClick={captureHere}
                                aria-label="Capture this frame (s)"
                                title="Capture this frame (s)"
                            >
                                <CaptureGlyph />
                            </ActionIcon>
                        )}

                        {/* The speed as a word that opens a menu, not a form field: the Select
                            it replaces was too narrow on a phone to show its own value, and its
                            list was as narrow as the field, so the labels wrapped. */}
                        {!compact && (
                            <Menu
                                position="top-end"
                                withinPortal
                                classNames={{ item: classes.menuItem }}
                            >
                                <Menu.Target>
                                    <Button
                                        variant="subtle"
                                        color="brass"
                                        size="compact-sm"
                                        h={coarse ? 44 : undefined}
                                        aria-label="Playback speed (− and +)"
                                        title="Playback speed (− and +)"
                                    >
                                        {speedLabel}
                                    </Button>
                                </Menu.Target>
                                <Menu.Dropdown>{speedItems}</Menu.Dropdown>
                            </Menu>
                        )}

                        {!compact && (
                            <ActionIcon
                                variant="subtle"
                                color="brass"
                                size={iconSize}
                                onClick={toggleMute}
                                aria-label={muted ? "Unmute" : "Mute"}
                            >
                                {muted ? <MutedGlyph /> : <SoundGlyph />}
                            </ActionIcon>
                        )}

                        <ActionIcon
                            variant="subtle"
                            color="brass"
                            size={iconSize}
                            onClick={toggleFullscreen}
                            aria-label={isFullscreen ? "Leave fullscreen" : "Fullscreen"}
                        >
                            <FullscreenGlyph />
                        </ActionIcon>

                        {/* On a phone, what did not fit; everywhere, the page's own actions --
                            the rating and the bin, which fullscreen otherwise puts out of reach
                            of anyone without a keyboard. */}
                        {(compact || menuItems) && (
                            <Menu
                                position="top-end"
                                withinPortal
                                classNames={{ item: classes.menuItem }}
                                onClose={() => setMoreView("actions")}
                            >
                                <Menu.Target>
                                    <ActionIcon
                                        variant="subtle"
                                        color="brass"
                                        size={iconSize}
                                        aria-label="More"
                                        title="More"
                                    >
                                        <MoreGlyph />
                                    </ActionIcon>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    {moreView === "speed" ? (
                                        <>
                                            <Menu.Item
                                                closeMenuOnClick={false}
                                                onClick={() => setMoreView("actions")}
                                            >
                                                ‹ Speed
                                            </Menu.Item>
                                            <Menu.Divider />
                                            {speedItems}
                                        </>
                                    ) : (
                                        <>
                                            {compact && (
                                                <>
                                                    {/* A second page rather than a submenu:
                                                        one speed per line, full width, and
                                                        nothing opening sideways off a narrow
                                                        screen. */}
                                                    <Menu.Item
                                                        closeMenuOnClick={false}
                                                        onClick={() => setMoreView("speed")}
                                                        rightSection={
                                                            <Text size="xs" c="dimmed">
                                                                {speedLabel} ›
                                                            </Text>
                                                        }
                                                    >
                                                        Speed
                                                    </Menu.Item>
                                                    <Menu.Item
                                                        onClick={toggleMute}
                                                        leftSection={
                                                            muted ? (
                                                                <MutedGlyph size={18} />
                                                            ) : (
                                                                <SoundGlyph size={18} />
                                                            )
                                                        }
                                                    >
                                                        {muted ? "Unmute" : "Mute"}
                                                    </Menu.Item>
                                                    {onCapture && (
                                                        <Menu.Item
                                                            onClick={captureHere}
                                                            disabled={capturing}
                                                            leftSection={<CaptureGlyph />}
                                                        >
                                                            Capture this frame
                                                        </Menu.Item>
                                                    )}
                                                    {markClip && (
                                                        <Menu.Item
                                                            onClick={markClip}
                                                            leftSection={<ScissorsGlyph />}
                                                        >
                                                            {clipPending
                                                                ? "Mark the clip's end"
                                                                : "Mark a clip's start"}
                                                        </Menu.Item>
                                                    )}
                                                    {menuItems && <Menu.Divider />}
                                                </>
                                            )}
                                            {menuItems}
                                        </>
                                    )}
                                </Menu.Dropdown>
                            </Menu>
                        )}
                    </Group>
                </Box>
            )}
        </Box>
    );
};
