"use client";

import { useEffect, useId, useSyncExternalStore } from "react";

import { advanceTo, type SlotState } from "./videoSlots";

/**
 * What the warming overlay reads (§8b, "Seeing it work").
 *
 * Warming is invisible by construction — the element doing it is one transparent pixel — and
 * §8b's warning is that a warm at the wrong offset and no warm at all look the same from the
 * outside. This is where the players say what they are doing, so an admin can see it on top of
 * the picture instead of inferring it from how a join felt.
 *
 * **Inert unless switched on.** Every report checks `isEnabled()` first and returns, so the
 * cost to somebody who never opened the admin tools is a module variable read per arrival. The
 * switch is per device, in `localStorage`, for the reason the playback preferences are: it is a
 * fact about the machine being diagnosed, not about the account.
 *
 * Module state rather than a React context: the players that report and the overlay that reads
 * live in unrelated trees (the tasting is not under the app shell), and a participant that
 * re-renders sixty times a second must not re-render the overlay by doing so. The overlay polls.
 */

const STORAGE_KEY = "ps:warmingHud";

/** How many joins the overlay keeps. Enough to see a pattern, few enough to read. */
const HISTORY = 12;

/**
 * How long each join is watched after it happens.
 *
 * Long enough to see a picture arrive and playback either start or stall after it, which is
 * where an intermittent join goes wrong; short enough that the console line arrives while the
 * person who saw the stall still remembers it.
 */
const OBSERVE_MS = 10_000;

/** Events kept per join. A stalling element can fire `waiting` and `stalled` many times. */
const MAX_EVENTS = 30;

/**
 * How close the buffer has to come to the start for it to count as covering it.
 *
 * A browser that seeks a warmed element to 01:40 buffers from the keyframe before it, and a
 * range that ends a few hundred milliseconds short of the start is a range read before the seek
 * landed rather than a miss.
 */
const COVER_TOLERANCE_MS = 500;

export type WarmSource = "viewer" | "reel" | "tasting" | "still" | "tasting-still" | "showcase";

/**
 * Why the next item is or is not warming.
 *
 * `refused` is the device (`videoWarming.ts`), `waiting` is the current item's prior claim
 * (§8b: nothing warms until it reaches `canplay`), `none` is a caller that offered nothing and
 * `same-file` is a next item that will be a seek on the element already playing.
 */
export type WarmGate = "refused" | "waiting" | "none" | "same-file" | "warming";

/** How the player got to an item. `cue` is a held element let go (§14g). */
export type JoinKind = "swap" | "seek" | "cold" | "cue";

export interface WarmParticipant {
    source: WarmSource;
    currentId: string;
    /** What the caller asked to have warmed, and from where. */
    offered: { id: string; startMs: number | null } | null;
    gate: WarmGate;
    /** Paused on its in point for a turn that has not come yet (§14g). */
    held: boolean;
    live: () => HTMLVideoElement | HTMLImageElement | null;
    warming: () => HTMLVideoElement | HTMLImageElement | null;
}

export interface JoinRecord {
    id: number;
    /** Which participant made it, so the overlay can follow whatever joined last. */
    participant: string;
    source: WarmSource;
    kind: JoinKind;
    mediaId: string;
    /** Where playback was meant to start, or null for a still. */
    targetMs: number | null;
    /** Whether what had been buffered contained the start at the moment of arrival. */
    covered: boolean;
    readyState: number | null;
    /**
     * `watching` for `OBSERVE_MS` after the join; then `ready` if a picture came, `gave-up` if
     * none did, or `left` when the viewer moved on before it came.
     */
    outcome: "watching" | "ready" | "left" | "gave-up";
    /** Arrival to a decoded picture with no seek in flight. */
    readyMs: number | null;
    /**
     * Arrival to the element's first `playing` — the moment the picture actually moves. A swap
     * can have a picture in 40 ms and still not play for seconds, and this is the gap.
     */
    playingMs: number | null;
    /** How much was buffered past the start at the moment of arrival, or null for a still. */
    aheadMs: number | null;
    /**
     * What the element said after the arrival, in milliseconds since it: `play`, `playing`,
     * `waiting`, `stalled`, `seeking`, `seeked`, `pause`, `canplay`, and `play-refused` from the
     * player's own `play()` calls. Read in order, these are the account of an intermittent stall.
     */
    events: readonly JoinEvent[];
    /**
     * Where the picture was when it appeared. Compared with `targetMs`, this is the one number
     * that tells a warm at the wrong offset from a warm that worked (§8b).
     */
    landedMs: number | null;
}

export interface JoinEvent {
    atMs: number;
    name: string;
    detail?: string;
}

/** How far from the start a first picture can land before it is called off target. */
const OFF_TARGET_MS = 2_000;

export const offTarget = (join: JoinRecord): boolean =>
    join.targetMs !== null &&
    join.landedMs !== null &&
    Math.abs(join.landedMs - join.targetMs) > OFF_TARGET_MS;

/** What the viewer page wanted warmed and why it could not be, for a bare "nothing offered". */
export interface WarmIntent {
    nextId: string | null;
    note: string;
}

let enabled: boolean | null = null;
const participants = new Map<string, WarmParticipant>();
let joins: readonly JoinRecord[] = [];
let intent: WarmIntent | null = null;
let nextJoinId = 1;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

/**
 * Read on first use rather than at import, so the server never touches `localStorage`. Safe to
 * call during render: it decides only whether to keep records, never what is drawn.
 */
export const isEnabled = (): boolean => {
    if (enabled === null) {
        if (typeof window === "undefined") return false;

        try {
            enabled = localStorage.getItem(STORAGE_KEY) === "1";
        } catch {
            enabled = false;
        }
    }

    return enabled;
};

export const setEnabled = (value: boolean): void => {
    enabled = value;

    try {
        localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
        // Not persisted; the switch still holds for this page.
    }

    if (!value) {
        participants.clear();
        joins = [];
        intent = null;
    }

    notify();
};

/** The switch, for the admin tools and the overlay. False on the server and the first render. */
export const useWarmingHudEnabled = (): boolean =>
    useSyncExternalStore(subscribe, isEnabled, () => false);

/** The joins so far, newest last. Changes identity only when a join is recorded or completes. */
export const useJoinHistory = (): readonly JoinRecord[] =>
    useSyncExternalStore(
        subscribe,
        () => joins,
        () => joins
    );

export const listParticipants = (): [string, WarmParticipant][] => [...participants.entries()];

export const currentIntent = (): WarmIntent | null => intent;

/**
 * Report what a player is doing, every render, while the overlay is on. Null reports nothing.
 *
 * Written in an effect with no dependency list on purpose: the record is a handful of fields
 * and two getters, cheaper to overwrite than to compare, and the overlay reads it on its own
 * clock rather than being told.
 */
export const useWarmParticipant = (participant: WarmParticipant | null): string => {
    const id = useId();

    useEffect(() => {
        if (participant !== null && isEnabled()) {
            participants.set(id, participant);
        }
    });

    useEffect(() => () => void participants.delete(id), [id]);

    return id;
};

/** The viewer's account of its next item, cleared when the viewer goes. */
export const useWarmIntent = (next: WarmIntent | null): void => {
    const nextId = next?.nextId ?? null;
    const note = next?.note ?? null;

    useEffect(() => {
        if (!isEnabled()) return;

        intent = note === null ? null : { nextId, note };

        return () => {
            intent = null;
        };
    }, [nextId, note]);
};

/**
 * How a player arrived at `mediaId`, given where its two elements stood just before.
 *
 * `advanceTo` is the same arithmetic `assignSlots` acts on, asked one step earlier: is the
 * arriving id the element already on screen (a seek), the other one (a swap — the warm paid
 * off), or neither (cold)? A held element let go is a cue, whatever its slot says.
 */
export const classifyJoin = (slots: SlotState, mediaId: string, released: boolean): JoinKind =>
    released ? "cue" : advanceTo(slots, mediaId).kind;

/** `TimeRanges` as plain millisecond pairs, so `covers` can be tested without a browser. */
export const rangesOf = (buffered: TimeRanges): [number, number][] => {
    const ranges: [number, number][] = [];

    for (let index = 0; index < buffered.length; index++) {
        ranges.push([buffered.start(index) * 1000, buffered.end(index) * 1000]);
    }

    return ranges;
};

/** Whether anything buffered contains the start, give or take a keyframe's worth. */
export const covers = (ranges: readonly [number, number][], targetMs: number): boolean =>
    ranges.some(
        ([start, end]) =>
            start - COVER_TOLERANCE_MS <= targetMs && targetMs <= end + COVER_TOLERANCE_MS
    );

/** Shown in the overlay and in the console. */
export const formatMs = (ms: number): string => {
    const total = Math.max(0, ms);
    const minutes = Math.floor(total / 60_000);
    const seconds = (total % 60_000) / 1000;

    return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
};

export const formatDuration = (ms: number): string =>
    ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

export const describeEvents = (events: readonly JoinEvent[]): string =>
    events
        .map(
            (event) =>
                `${event.name}${event.detail ? `(${event.detail})` : ""} ${Math.round(event.atMs)}`
        )
        .join(", ");

export const describeJoin = (join: JoinRecord): string => {
    const parts = [
        `[warm] ${join.kind.toUpperCase()}`,
        join.source,
        `${join.mediaId.slice(0, 8)}…`,
        join.targetMs === null ? null : `@${formatMs(join.targetMs)}`,
        join.covered ? "covered ✓" : "not covered ✗",
        join.aheadMs === null ? null : `${formatDuration(join.aheadMs)} ahead`,
        join.readyState === null ? null : `rs=${join.readyState}`,
        join.outcome === "gave-up"
            ? `→ no picture in ${OBSERVE_MS / 1000} s`
            : join.outcome === "left"
              ? "→ left before a picture"
              : join.readyMs === null
                ? null
                : `→ picture in ${formatDuration(join.readyMs)}`,
        join.playingMs === null ? null : `playing in ${formatDuration(join.playingMs)}`,
        join.landedMs !== null && offTarget(join)
            ? `at ${formatMs(join.landedMs)} ✗ OFF TARGET`
            : null,
        join.events.length === 0 ? null : `· ${describeEvents(join.events)}`,
    ];

    return parts.filter((part) => part !== null).join(" ");
};

const replace = (id: number, change: (join: JoinRecord) => Partial<JoinRecord>) => {
    joins = joins.map((join) => (join.id === id ? { ...join, ...change(join) } : join));
    notify();
};

export interface JoinHandle {
    /** A picture is up, at `landedMs` (null for a still). */
    ready: (at: number, landedMs: number | null) => void;
    /** Something the element said. The first `playing` is also the join's `playingMs`. */
    event: (at: number, name: string, detail?: string) => void;
    /** Stop watching: the player moved on, or went away. */
    close: () => void;
}

/**
 * Start recording a join.
 *
 * Returns null when the overlay is off, so a caller's whole bookkeeping is one null check. Watches
 * for `OBSERVE_MS`, or until closed, and writes one console line when it stops — `console.info`,
 * which DevTools shows by default; `debug` is its hidden "Verbose" level.
 */
export const beginJoin = (
    join: Omit<JoinRecord, "id" | "outcome" | "readyMs" | "playingMs" | "landedMs" | "events">,
    startedAt: number
): JoinHandle | null => {
    if (!isEnabled()) return null;

    const id = nextJoinId++;
    let done = false;

    const record: JoinRecord = {
        ...join,
        id,
        outcome: "watching",
        readyMs: null,
        playingMs: null,
        landedMs: null,
        events: [],
    };

    joins = [...joins, record].slice(-HISTORY);
    notify();

    const since = (at: number) => Math.max(0, at - startedAt);

    const stop = (left: boolean) => {
        if (done) return;

        done = true;
        clearTimeout(limit);
        replace(id, (current) => ({
            outcome: current.readyMs !== null ? "ready" : left ? "left" : "gave-up",
        }));

        const finished = joins.find((candidate) => candidate.id === id);

        if (finished) {
            console.info(describeJoin(finished));
        }
    };

    const limit = setTimeout(() => stop(false), OBSERVE_MS);

    return {
        ready: (at, landedMs) => {
            if (done) return;

            replace(id, (current) =>
                current.readyMs === null ? { readyMs: since(at), landedMs } : {}
            );
        },
        event: (at, name, detail) => {
            if (done) return;

            replace(id, (current) => ({
                events:
                    current.events.length >= MAX_EVENTS
                        ? current.events
                        : [...current.events, { atMs: since(at), name, detail }],
                playingMs:
                    name === "playing" && current.playingMs === null
                        ? since(at)
                        : current.playingMs,
            }));
        },
        close: () => stop(true),
    };
};
