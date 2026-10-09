"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MediaListItem } from "@private-stock/core";

import { pickVoice, voiceLeaving, type VoiceCandidate } from "@/lib/showcase/voice";
import { pickSegment, segmentAt, type Segment } from "@/lib/tasting/segment";
import { mayWarmNextItem } from "@/lib/videoWarming";

/**
 * The showcase's voice: one tile at a time playing a taste of its film with sound (§14f).
 *
 * The stage is an engine that knows where every tile is each frame; this decides which of them
 * speaks. It keeps two things — the tile playing (`live`) and, where the device may spend the
 * bandwidth, the tile that will play next (`cued`), a held player already sought to its
 * segment — and a slow ticker that reads the stage's geometry and moves them on.
 */

/** Where a tile is on screen, written by the stage's loop every frame. */
export interface TileGeometry {
    item: MediaListItem;
    top: number;
    height: number;
}

export interface VoiceSlot {
    key: string;
    item: MediaListItem;
    segment: Segment;
    /** Which arrival this is: two visits to the same tile are two different plays. */
    token: number;
}

/** What a tile is told about its part in the voice. */
export interface TileVoice {
    role: "live" | "cued";
    /** The arrival, handed back with `onFinished` and `onRefused`. */
    token: number;
    span: { startMs: number; endMs: number; speed: null; token: string };
    muted: boolean;
}

/** Stable across renders, so passing them to every tile does not wake the memoised ones. */
export interface VoiceHandlers {
    /** The live tile's segment is over. */
    onFinished: (token: number) => void;
    /** The browser cannot play this item. */
    onUnplayable: (itemId: string) => void;
    /** The browser refused to start with sound without a gesture. */
    onRefused: (token: number) => void;
}

interface Options {
    enabled: boolean;
    clipMs: number;
    muted: boolean;
    tilesRef: { current: Map<string, TileGeometry> };
    /** Signed px/s the wall is carrying tiles upwards, read fresh at every tick. */
    driftRef: { current: number };
    /** A look's matching moments, by item id (§5e): a taste of one opens on its match. */
    momentsRef: { current: ReadonlyMap<string, number> };
    viewport: number;
}

/** How often the voice looks at the wall. The wall moves 22 px/s; this is plenty. */
const TICK_MS = 250;

/** How long before the live tile ends the next one is chosen and cued. */
const CUE_LEAD_MS = 5_000;

/** A live tile whose playhead has not moved for this long is given up on, as in §14g. */
const STALL_MS = 15_000;

/** Items voiced recently, kept from being picked again straight away in a short set. */
const RECENT = 8;

interface State {
    live: VoiceSlot | null;
    cued: VoiceSlot | null;
}

const EMPTY: State = { live: null, cued: null };

/** Note an item as just voiced, newest first. */
const remember = (recent: { current: string[] }, slot: VoiceSlot): void => {
    recent.current = [slot.item.id, ...recent.current.filter((id) => id !== slot.item.id)].slice(
        0,
        RECENT
    );
};

const toTileVoice = (slot: VoiceSlot | null, role: TileVoice["role"], muted: boolean) =>
    slot
        ? {
              role,
              token: slot.token,
              span: { ...slot.segment, speed: null, token: `${slot.item.id}:${slot.token}` },
              muted,
          }
        : null;

export const useShowcaseVoice = ({
    enabled,
    clipMs,
    muted,
    tilesRef,
    driftRef,
    momentsRef,
    viewport,
}: Options): {
    voiceFor: (key: string) => TileVoice | null;
    handlers: VoiceHandlers;
    positionRef: { current: number };
    refused: boolean;
    unlock: () => void;
    liveKey: string | null;
} => {
    const [state, setState] = useState<State>(EMPTY);
    const [refused, setRefused] = useState(false);
    const [mayCue, setMayCue] = useState(false);

    const stateRef = useRef(state);
    stateRef.current = state;

    const positionRef = useRef(0);
    const failed = useRef(new Set<string>());
    const recent = useRef<string[]>([]);
    const tokens = useRef(0);
    const options = useRef({ clipMs, viewport });
    options.current = { clipMs, viewport };

    // Read on the client only: the server has no connection or pointer to ask about.
    useEffect(() => setMayCue(mayWarmNextItem()), []);

    const candidates = useCallback((): VoiceCandidate[] => {
        const list: VoiceCandidate[] = [];

        for (const [key, tile] of tilesRef.current) {
            list.push({ key, item: tile.item, top: tile.top, height: tile.height });
        }

        return list;
    }, [tilesRef]);

    const pick = useCallback(
        (leadMs: number, also: (string | undefined)[]): VoiceSlot | null => {
            const { clipMs: clip, viewport: height } = options.current;
            const list = candidates();
            const avoid = also.filter((value): value is string => Boolean(value));
            const attempt = (exclude: string[]) =>
                pickVoice(list, {
                    viewport: height,
                    driftPxPerS: driftRef.current,
                    leadMs,
                    clipMs: clip,
                    exclude: new Set([...failed.current, ...exclude]),
                });

            /**
             * Variety is a preference; silence is the failure. A still wall has one row in the
             * middle — three tiles, often — and once each has spoken, refusing everything recent
             * left the wall mute until it drifted on. So each refusal is let go in turn: first
             * the recent items, then the tile that just spoke, which plays a fresh moment of
             * itself -- or its match again, in a look's set. Only an item the browser cannot play stays out.
             */
            const tile = attempt([...recent.current, ...avoid]) ?? attempt(avoid) ?? attempt([]);

            if (!tile) return null;

            tokens.current += 1;

            // Chosen once, here, and kept: a cued tile warms from this in point (§14g's
            // reservation), and arriving must play the seconds that were warmed. A look's set
            // opens each item on its match, as the tasting does; anything else, on a random one.
            const matchedAt = momentsRef.current.get(tile.item.id);

            return {
                key: tile.key,
                item: tile.item,
                segment:
                    matchedAt === undefined
                        ? pickSegment(tile.item.durationMs, clip)
                        : segmentAt(tile.item.durationMs, clip, matchedAt),
                token: tokens.current,
            };
        },
        [candidates, driftRef, momentsRef]
    );

    /** The live tile has had its turn, one way or another. The cued one takes over. */
    const advance = useCallback(() => {
        const { live, cued } = stateRef.current;
        const next =
            cued && tilesRef.current.has(cued.key) ? cued : pick(0, [live?.key, live?.item.id]);

        if (next) remember(recent, next);

        positionRef.current = 0;
        stateRef.current = { live: next, cued: null };
        setState(stateRef.current);
    }, [pick, tilesRef]);

    // Off, or the filter was changed under it: nothing plays.
    useEffect(() => {
        if (enabled) return;

        stateRef.current = EMPTY;
        setState(EMPTY);
        setRefused(false);
    }, [enabled]);

    // --- The ticker ---
    useEffect(() => {
        if (!enabled || refused || viewport === 0) return;

        let lastPosition = -1;
        let lastMotion = Date.now();
        let watching: number | null = null;

        const tick = () => {
            const { live, cued } = stateRef.current;
            const tiles = tilesRef.current;

            if (!live) {
                const first = pick(0, []);

                if (first) {
                    remember(recent, first);
                    positionRef.current = 0;
                    stateRef.current = { live: first, cued: null };
                    setState(stateRef.current);
                }

                return;
            }

            const here = tiles.get(live.key);

            // Gone off the wall, or out of the middle: hand on early rather than talk from
            // the edge of the screen.
            if (!here || voiceLeaving(here.top, here.height, viewport)) {
                advance();
                return;
            }

            // A playhead that has stopped is a film that will never reach its out point.
            if (watching !== live.token) {
                watching = live.token;
                lastPosition = positionRef.current;
                lastMotion = Date.now();
            } else if (positionRef.current !== lastPosition || document.hidden) {
                lastPosition = positionRef.current;
                lastMotion = Date.now();
            } else if (Date.now() - lastMotion > STALL_MS) {
                failed.current.add(live.item.id);
                advance();
                return;
            }

            // A cued tile that has drifted away is no use for the handoff.
            if (cued) {
                const there = tiles.get(cued.key);

                if (!there || voiceLeaving(there.top, there.height, viewport)) {
                    stateRef.current = { live, cued: null };
                    setState(stateRef.current);
                }

                return;
            }

            if (!mayCue) return;

            const position = positionRef.current;
            const length = live.segment.endMs - live.segment.startMs;
            const played =
                position >= live.segment.startMs && position <= live.segment.endMs
                    ? position - live.segment.startMs
                    : 0;
            const remaining = Math.max(0, length - played);

            if (remaining > CUE_LEAD_MS) return;

            const next = pick(remaining, [live.key, live.item.id]);

            if (next) {
                stateRef.current = { live, cued: next };
                setState(stateRef.current);
            }
        };

        tick();

        const timer = setInterval(tick, TICK_MS);

        return () => clearInterval(timer);
    }, [enabled, refused, viewport, mayCue, pick, advance, tilesRef]);

    // --- What tiles say back ---
    const handlers = useMemo<VoiceHandlers>(
        () => ({
            onFinished: (token) => {
                if (stateRef.current.live?.token === token) advance();
            },
            onUnplayable: (itemId) => {
                failed.current.add(itemId);

                const { live, cued } = stateRef.current;

                if (live?.item.id === itemId) {
                    advance();
                } else if (cued?.item.id === itemId) {
                    stateRef.current = { live, cued: null };
                    setState(stateRef.current);
                }
            },
            /**
             * No sound without a gesture: a reload, or a link opened cold. The wall carries on
             * without a voice, rather than stopping on one big play button as the tasting does
             * (§14g) — the wall is worth watching silent, a tasting is not.
             */
            onRefused: (token) => {
                if (stateRef.current.live?.token !== token) return;

                stateRef.current = EMPTY;
                setState(EMPTY);
                setRefused(true);
            },
        }),
        [advance]
    );

    /** A gesture has happened: sound is allowed now, so the ticker may try again. */
    const unlock = useCallback(() => setRefused(false), []);

    // Built once per change rather than per call, so the two tiles concerned are handed the
    // same object on every render of the stage and their memo holds.
    const liveVoice = useMemo(() => toTileVoice(state.live, "live", muted), [state.live, muted]);
    const cuedVoice = useMemo(() => toTileVoice(state.cued, "cued", muted), [state.cued, muted]);

    const voiceFor = useCallback(
        (key: string): TileVoice | null =>
            state.live?.key === key ? liveVoice : state.cued?.key === key ? cuedVoice : null,
        [state, liveVoice, cuedVoice]
    );

    return {
        voiceFor,
        handlers,
        positionRef,
        refused,
        unlock,
        liveKey: state.live?.key ?? null,
    };
};
