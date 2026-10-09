"use client";

import { useEffect, useRef } from "react";

import type { SlotState } from "./videoSlots";
import {
    beginJoin,
    classifyJoin,
    covers,
    isEnabled,
    rangesOf,
    useWarmParticipant,
    type JoinHandle,
    type JoinKind,
    type WarmGate,
    type WarmSource,
} from "./warmMonitor";

/**
 * A stage's side of the warming overlay (§8b, "Seeing it work").
 *
 * Shared by `VideoPlayer` and `StillSlots`, which keep the same two slots for different
 * elements. Neither changes what it does for this: it watches the elements and reports. Off, it
 * costs one module read per render.
 *
 * **Must be called with the slots as they stood before this render's `assignSlots`.** The join
 * is classified against where the elements were *before* the arrival — after it, the arriving
 * id is always the active one, and every join would look like a seek.
 */

type Watched = HTMLVideoElement | HTMLImageElement;

/** How each kind of element says it is ready, and what is worth recording about it. */
interface Probe<E extends Watched> {
    /** The events after which it might have become ready. */
    events: readonly string[];
    /** The events worth writing into the join's timeline. */
    recorded: readonly string[];
    /** How much was buffered past the start, or null for something without a timeline. */
    ahead: (element: E, targetMs: number) => number | null;
    /** Whether what was held at the moment of arrival already contained the start. */
    covered: (element: E, targetMs: number) => boolean;
    readyState: (element: E) => number | null;
    /** A picture is up, and no seek is in flight. */
    ready: (element: E) => boolean;
    /** Where that picture is, or null for something without a timeline. */
    landed: (element: E) => number | null;
}

/**
 * Fired on the element by the player when one of its own `play()` calls is refused, with the
 * error's name as the detail. The browser says nothing when that happens — no event, just a
 * rejected promise the player used to swallow — and "play was never asked for" and "play was
 * asked for and refused" are different diagnoses of a join that did not start.
 */
export const PLAY_REFUSED_EVENT = "ps:play-refused";

export const videoProbe: Probe<HTMLVideoElement> = {
    events: ["loadeddata", "seeked", "canplay", "playing", "timeupdate"],
    recorded: [
        "play",
        "playing",
        "waiting",
        "stalled",
        "seeking",
        "seeked",
        "pause",
        "canplay",
        "error",
        PLAY_REFUSED_EVENT,
    ],
    ahead: (video, targetMs) => {
        const range = rangesOf(video.buffered).find(
            ([start, end]) => start - 500 <= targetMs && targetMs <= end
        );

        return range ? range[1] - targetMs : 0;
    },
    covered: (video, targetMs) => covers(rangesOf(video.buffered), targetMs),
    readyState: (video) => video.readyState,
    /**
     * A decoded picture with no seek in flight, wherever it landed. Not "at the target": a
     * picture somewhere else is exactly what this exists to catch, so it is recorded with its
     * position rather than waited out.
     */
    ready: (video) => video.readyState >= 2 && !video.seeking && video.videoWidth > 0,
    landed: (video) => video.currentTime * 1000,
};

export const stillProbe: Probe<HTMLImageElement> = {
    events: ["load"],
    recorded: ["load", "error"],
    ahead: () => null,
    covered: (image) => image.complete && image.naturalWidth > 0,
    readyState: () => null,
    ready: (image) => image.complete && image.naturalWidth > 0,
    landed: () => null,
};

interface WarmReport<E extends Watched> {
    /** Undefined for a stage nobody asked to report. */
    source: WarmSource | undefined;
    probe: Probe<E>;
    mediaId: string;
    /** Changes on every arrival: the id, plus a span's token when there is one. */
    arrival: string;
    /** Paused on its in point, or hidden, for a turn that has not come yet (§14g). */
    held: boolean;
    /** The slots as the previous render left them. */
    slots: SlotState;
    /** Where this arrival is meant to start, in milliseconds, or null for a still. */
    targetMs: number | null;
    offered: { id: string; startMs: number | null } | null;
    gate: WarmGate;
    live: () => E | null;
    warming: () => E | null;
}

export const useWarmReport = <E extends Watched>({
    source,
    probe,
    mediaId,
    arrival,
    held,
    slots,
    targetMs,
    offered,
    gate,
    live,
    warming,
}: WarmReport<E>): void => {
    const lastArrival = useRef<string | null>(null);
    const cued = useRef<string | null>(null);
    const pending = useRef<{ kind: JoinKind; at: number } | null>(null);
    /**
     * Counts joins, and is what the effect below is keyed on. Not the element: the player
     * mirrors its element into state a render after the commit that attached it, and an effect
     * keyed on that would tear down — and abandon — a join it had only just started.
     */
    const sequence = useRef(0);

    /**
     * Written during render, like the slots beside it, because this is the only moment the
     * previous slots are still on hand. Idempotent under a second render: the arrival has
     * already been seen and nothing moves.
     */
    if (source !== undefined && isEnabled()) {
        if (lastArrival.current !== arrival) {
            // The first arrival is an opening, and an opening is always cold: the slots were
            // built around it, so they would call it a seek.
            const opening = lastArrival.current === null;

            lastArrival.current = arrival;

            if (held) {
                // A cue: the join is when it is let go, not when it was laid down (§14g).
                cued.current = arrival;
                pending.current = null;
            } else {
                cued.current = null;
                sequence.current += 1;
                pending.current = {
                    kind: opening ? "cold" : classifyJoin(slots, mediaId, false),
                    at: performance.now(),
                };
            }
        } else if (!held && cued.current === arrival) {
            cued.current = null;
            sequence.current += 1;
            pending.current = { kind: "cue", at: performance.now() };
        }
    }

    const participant = useWarmParticipant(
        source === undefined
            ? null
            : { source, currentId: mediaId, offered, gate, held, live, warming }
    );

    const joinSequence = sequence.current;

    /**
     * The join being timed. A ref rather than effect-local, so that an effect run twice (React's
     * strict mode does, in development) times one join rather than abandoning it and starting a
     * second.
     */
    const active = useRef<{
        sequence: number;
        handle: JoinHandle;
        element: E;
        /** A picture has been recorded; the timeline keeps going regardless. */
        pictured: boolean;
        closed: boolean;
    } | null>(null);

    useEffect(() => {
        const join = pending.current;
        const element = live();

        if (join && element && source !== undefined && active.current?.sequence !== joinSequence) {
            if (active.current && !active.current.closed) {
                active.current.closed = true;
                active.current.handle.close();
            }

            const handle = beginJoin(
                {
                    participant,
                    source,
                    kind: join.kind,
                    mediaId,
                    targetMs,
                    covered: probe.covered(element, targetMs ?? 0),
                    aheadMs: probe.ahead(element, targetMs ?? 0),
                    readyState: probe.readyState(element),
                },
                join.at
            );

            pending.current = null;
            active.current = handle
                ? { sequence: joinSequence, handle, element, pictured: false, closed: false }
                : null;
        }

        const timing = active.current;

        if (!timing || timing.closed) return;

        const check = () => {
            if (timing.pictured || !probe.ready(timing.element)) return;

            timing.pictured = true;
            timing.handle.ready(performance.now(), probe.landed(timing.element));
        };

        const record = (event: Event) => {
            const detail =
                event instanceof CustomEvent && typeof event.detail === "string"
                    ? event.detail
                    : undefined;

            timing.handle.event(performance.now(), event.type.replace(/^ps:/, ""), detail);
        };

        // One frame later, so the arrival's own seek — declared further down the player — has
        // been issued and `seeking` says so.
        const frame = requestAnimationFrame(check);

        probe.events.forEach((event) => timing.element.addEventListener(event, check));
        probe.recorded.forEach((event) => timing.element.addEventListener(event, record));

        return () => {
            cancelAnimationFrame(frame);
            probe.events.forEach((event) => timing.element.removeEventListener(event, check));
            probe.recorded.forEach((event) => timing.element.removeEventListener(event, record));
        };
        // Keyed on the join alone: everything else is read at the moment it starts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [joinSequence]);

    /**
     * A stage that goes away mid-join: the viewer left before the picture came.
     *
     * Decided a task later, because strict mode unmounts and remounts every effect once in
     * development, and a remount is not a departure.
     */
    const mounted = useRef(false);

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;

            setTimeout(() => {
                const timing = active.current;

                if (!mounted.current && timing && !timing.closed) {
                    timing.closed = true;
                    timing.handle.close();
                }
            });
        };
    }, []);
};
