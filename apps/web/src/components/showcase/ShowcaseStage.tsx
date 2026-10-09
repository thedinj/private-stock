"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionIcon, Loader, Text, Tooltip } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";

import type { MediaCountResponse, MediaListItem } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { rememberReturnTo } from "@/lib/returnTo";
import {
    type ConveyorPosition,
    type ConveyorSpan,
    normalize,
    pageOfBlock,
    placeBlocks,
    shouldWrap,
} from "@/lib/showcase/conveyor";
import { type JustifiedBlock, justify, tileAspect } from "@/lib/showcase/justify";
import {
    type ShowcasePosition,
    readShowcasePosition,
    saveShowcasePosition,
} from "@/lib/showcase/restore";
import { fetchShowcasePage } from "@/lib/showcase/pages";
import { SHOWCASE_PAGE_SIZE, type ShowcaseSet, showcaseSetKey } from "@/lib/showcase/set";
import { CloseGlyph, FullscreenGlyph, SoundGlyph } from "@/components/media/Glyph";
import { usePlaybackPref, useTastingClipSeconds } from "@/lib/playbackPrefs";
import { useIdleControls } from "@/lib/useIdleControls";
import { useWakingTap } from "@/lib/useWakingTap";
import { usePlayerFullscreen } from "@/lib/usePlayerFullscreen";

import { ShowcaseSoundMenu } from "./ShowcaseSoundMenu";
import { ShowcaseTile } from "./ShowcaseTile";
import { type TileGeometry, useShowcaseVoice } from "./useShowcaseVoice";
import classes from "./Showcase.module.scss";

/**
 * The showcase: the library as one endless, slowly moving wall of pictures (§14f).
 *
 * Nothing here scrolls natively. The wall is a conveyor of blocks — one per fetched page,
 * each laid out on its own — and a single `requestAnimationFrame` loop moves one layer with a
 * transform. React renders only when a row enters or leaves the window, which during a drift
 * is every few seconds rather than every frame; everything else is arithmetic on refs.
 */

interface ShowcaseStageProps {
    /** What the wall shows. Memoised by the caller: a new object is a new wall. */
    set: ShowcaseSet;
    onExit: () => void;
}

const GAP = 4;

/** Stillness before the wall starts to move, and how long it may sit on a hovered clip. */
const DRIFT_IDLE_MS = 4_000;
const HOVER_HOLD_MS = 12_000;

/** Seconds for the drift to ease in or out. Long enough to read as a camera, not a jolt. */
const DRIFT_EASE_S = 1.2;

/** How long a set too short to wrap rests at either end before drifting back. */
const END_REST_MS = 2_500;

/** Rows mounted beyond the screen, as fractions of its height: less above, since we go down. */
const MOUNT_BEFORE = 0.25;
const MOUNT_AFTER = 0.75;

/** Blocks fetched this far ahead, in screens, so the drift never meets a wall. */
const FETCH_AHEAD = 3;

/** How far from the current page a block may be before its items are let go. */
const KEEP_PAGES = 3;

/** Row height, and the drift speed that suits it. */
const geometry = (width: number): { rowHeight: number; driftSpeed: number } => {
    // Large tiles, few of them: the clips are 480p, and the preview budget grants a handful of
    // decoders at most (§9). A wall of forty small tiles would be thirty-two standing still.
    if (width < 600) {
        return { rowHeight: 200, driftSpeed: 14 };
    }

    if (width < 1200) {
        return { rowHeight: 300, driftSpeed: 18 };
    }

    return { rowHeight: 360, driftSpeed: 22 };
};

interface RenderTile {
    item: MediaListItem;
    x: number;
    width: number;
}

interface RenderRow {
    key: string;
    /** Relative to the top of the base block, which is where the layer's origin is. */
    top: number;
    height: number;
    tiles: RenderTile[];
    central: boolean;
    /** The page of the set this row came from — what the viewer steps through after it. */
    page: number;
}

interface Frame {
    base: number;
    rows: RenderRow[];
}

const prefersReducedMotion = (): boolean =>
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
    } else {
        void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
};

export const ShowcaseStage: React.FC<ShowcaseStageProps> = ({ set, onExit }) => {
    /** The identity of the wall: what it resets on, and what a saved position belongs to. */
    const filter = showcaseSetKey(set);
    const queryClient = useQueryClient();

    const stageRef = useRef<HTMLDivElement>(null);
    const layerRef = useRef<HTMLDivElement>(null);

    const [size, setSize] = useState({ width: 0, height: 0 });
    const [frame, setFrame] = useState<Frame>({ base: 0, rows: [] });
    const [pageCount, setPageCount] = useState<number | null>(null);
    const [reducedMotion] = useState(prefersReducedMotion);

    const pages = useRef(new Map<number, MediaListItem[]>());
    /** A look's matching moments, by item id (§5e); kept for the set, not evicted with pages. */
    const moments = useRef(new Map<string, number>());
    const layouts = useRef(new Map<number, JustifiedBlock>());
    const inflight = useRef(new Set<number>());
    const pageCountRef = useRef<number | null>(null);
    const filterRef = useRef(filter);
    filterRef.current = filter;
    const position = useRef<ConveyorPosition>({ block: 0, offset: 0 });
    /** Where the saved position still has to be applied, once its block is laid out. */
    const pendingRestore = useRef<ShowcasePosition | null>(null);
    const tops = useRef(new Map<number, number>());
    const signature = useRef("");
    const renderedBase = useRef(0);

    const { rowHeight, driftSpeed } = geometry(size.width);

    // --- Input state, read by the loop ---
    const wheelPending = useRef(0);
    const momentum = useRef(0);
    const driftVelocity = useRef(0);
    /** Down, or back up: only a set too short to wrap ever turns round. */
    const driftDirection = useRef<1 | -1>(1);
    const driftRestUntil = useRef(0);
    const drag = useRef<{
        id: number;
        lastY: number;
        lastT: number;
        velocity: number;
        moved: boolean;
    } | null>(null);
    const suppressClick = useRef(false);
    const lastInput = useRef(0);
    const pointedRef = useRef(false);

    // --- The voice (§14f) ---
    const [sound, setSound] = usePlaybackPref("showcaseSound");
    const [muted, setMuted] = usePlaybackPref("muted");
    const [clipSeconds, setClipSeconds] = useTastingClipSeconds();
    const [soundOpen, setSoundOpen] = useState(false);
    const soundOpenRef = useRef(soundOpen);
    soundOpenRef.current = soundOpen;
    /** Every mounted tile and where it is on screen, rewritten by the loop each frame. */
    const tilesRef = useRef(new Map<string, TileGeometry>());

    /**
     * Counted as a holder of the screen while the wall is up, as the tasting's stage is (§14g).
     * The voice mounts and unmounts players all the time, and the last player out of a full
     * screen the viewer asked for would otherwise take the wall out of it with them.
     */
    usePlayerFullscreen(stageRef);

    const controlsIdle = useIdleControls(true, () => soundOpenRef.current);
    /**
     * A tap while the controls are hidden only brings them back (`useWakingTap`, the tasting's
     * rule too). Every tap on the wall lands on a tile, so without this, reaching for the controls
     * on a phone opened whatever was under the finger.
     */
    const { onPointerDown: noteTapStart, consume: tapOnlyWoke } = useWakingTap(controlsIdle);
    const driftIdle = useIdleControls(
        !reducedMotion,
        () => pointedRef.current && performance.now() - lastInput.current < HOVER_HOLD_MS,
        DRIFT_IDLE_MS
    );
    const drifting = driftIdle && !reducedMotion;
    const driftingRef = useRef(drifting);
    driftingRef.current = drifting;

    const voice = useShowcaseVoice({
        enabled: sound && !reducedMotion,
        clipMs: clipSeconds * 1_000,
        muted,
        tilesRef,
        driftRef: driftVelocity,
        momentsRef: moments,
        viewport: size.height,
    });
    const unlockRef = useRef(voice.unlock);
    unlockRef.current = voice.refused ? voice.unlock : () => undefined;
    const soundKeysRef = useRef({ sound, muted, setSound, setMuted });
    soundKeysRef.current = { sound, muted, setSound, setMuted };

    /** Read fresh on every call: the page count and the first block both arrive late. */
    const span = (): ConveyorSpan => {
        const count = pageCountRef.current;

        return {
            pageCount: count,
            wrap: shouldWrap(count, layouts.current.get(0)?.height, size.height),
        };
    };

    // --- Size ---
    useLayoutEffect(() => {
        const element = stageRef.current;

        if (!element) return;

        const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });

        measure();

        const observer = new ResizeObserver(measure);

        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    // --- Restore, and reset when the filter changes ---
    useEffect(() => {
        pages.current.clear();
        moments.current.clear();
        layouts.current.clear();
        inflight.current.clear();
        pageCountRef.current = null;
        setPageCount(null);
        signature.current = "";

        const saved = readShowcasePosition(filter);

        position.current = { block: saved?.page ?? 0, offset: 0 };
        pendingRestore.current = saved;
    }, [filter]);

    const layoutPage = useCallback(
        (page: number) => {
            const items = pages.current.get(page);

            if (!items || size.width === 0) return;

            layouts.current.set(
                page,
                justify(
                    items.map((item) => tileAspect(item.width, item.height)),
                    size.width,
                    rowHeight,
                    GAP
                )
            );
        },
        [size.width, rowHeight]
    );

    /**
     * Re-hang the wall at a new width or row height, keeping the same place in the same block.
     */
    useEffect(() => {
        const anchorPage = pageOfBlock(position.current.block, span());
        const before = layouts.current.get(anchorPage)?.height;
        const fraction = before ? position.current.offset / before : null;

        for (const page of pages.current.keys()) {
            layoutPage(page);
        }

        const after = layouts.current.get(anchorPage)?.height;

        if (fraction !== null && after) {
            position.current = { ...position.current, offset: fraction * after };
        }

        signature.current = "";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutPage]);

    // --- Page count ---
    useEffect(() => {
        /**
         * A playlist's end is its last page's `hasMore`, as `fetchPage` reads it. Its pages are
         * sixty rather than two hundred, and a shuffled one runs past the item count (see
         * `PlaylistDetail`), so a count would give the wrong number of pages either way.
         */
        if (set.kind !== "library") return;

        let cancelled = false;

        void queryClient
            .fetchQuery({
                queryKey: queryKeys.media.count(set.filter),
                queryFn: () => api<MediaCountResponse>(`/api/media/count?${set.filter}`),
                staleTime: 60_000,
            })
            .then((count) => {
                if (cancelled) return;

                pageCountRef.current = Math.ceil(count.total / SHOWCASE_PAGE_SIZE);
                setPageCount(pageCountRef.current);
            })
            .catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [set, queryClient]);

    const fetchPage = useCallback(
        (page: number) => {
            if (page < 0 || pages.current.has(page) || inflight.current.has(page)) return;

            const count = pageCountRef.current;

            if (count !== null && page >= count) return;

            inflight.current.add(page);

            // The same key the viewer builds for this set, so opening a tile finds its page
            // already cached.
            void fetchShowcasePage(queryClient, set, page)
                .then((response) => {
                    inflight.current.delete(page);

                    // A different filter was chosen while this was in flight.
                    if (filterRef.current !== filter) return;

                    if (!response.hasMore && pageCountRef.current === null) {
                        pageCountRef.current = response.items.length > 0 ? page + 1 : page;
                        setPageCount(pageCountRef.current);
                    }

                    if (response.items.length === 0) return;

                    pages.current.set(page, response.items);

                    for (const [id, moment] of Object.entries(response.moments ?? {})) {
                        moments.current.set(id, moment.atMs);
                    }
                    layoutPage(page);
                    signature.current = "";
                })
                .catch(() => {
                    inflight.current.delete(page);
                });
        },
        [filter, layoutPage, queryClient, set]
    );

    // --- The loop ---
    useEffect(() => {
        if (size.height === 0) return;

        let raf = 0;
        let last = performance.now();

        const heightOf = (block: number): number | undefined =>
            layouts.current.get(pageOfBlock(block, span()))?.height;

        const step = (now: number) => {
            raf = requestAnimationFrame(step);

            const dt = Math.min(0.05, (now - last) / 1000);

            last = now;

            const viewport = size.height;
            const currentSpan = span();

            // Apply a saved position once its block exists to measure: the item the viewer
            // was last on, centred, or failing that the place the wall was left.
            const restore = pendingRestore.current;

            if (restore) {
                const page = pageOfBlock(position.current.block, span());
                const layout = layouts.current.get(page);
                const items = pages.current.get(page);

                if (layout && items) {
                    const index = restore.itemId
                        ? items.findIndex((item) => item.id === restore.itemId)
                        : -1;
                    const row =
                        index === -1
                            ? undefined
                            : layout.rows.find((candidate) =>
                                  candidate.tiles.some((tile) => tile.index === index)
                              );

                    position.current.offset = row
                        ? row.y + row.height / 2 - size.height / 2
                        : restore.fraction * layout.height;
                    pendingRestore.current = null;
                }
            }

            let delta = 0;

            if (!drag.current) {
                const wheelStep = wheelPending.current * Math.min(1, dt * 12);

                wheelPending.current -= wheelStep;
                delta += wheelStep;

                delta += momentum.current * dt;
                momentum.current *= Math.exp(-dt * 3.5);

                if (Math.abs(momentum.current) < 4) momentum.current = 0;

                const resting = now < driftRestUntil.current;
                const target =
                    driftingRef.current && !resting ? driftSpeed * driftDirection.current : 0;

                driftVelocity.current +=
                    (target - driftVelocity.current) * Math.min(1, dt / DRIFT_EASE_S);
                delta += driftVelocity.current * dt;
            }

            const before = position.current;

            position.current = normalize(
                { block: before.block, offset: before.offset + delta },
                heightOf,
                currentSpan,
                viewport
            );

            /**
             * A set too short to wrap has ends, and a drift that reaches one and stops looks
             * like the wall has died. It rests there a moment and drifts back the other way.
             *
             * Only once the whole set is known: until then an end is just a page that has not
             * arrived yet, and turning round at it would bounce off the next fetch.
             */
            const bounded = !currentSpan.wrap && currentSpan.pageCount !== null;
            const stuck =
                position.current.block === before.block &&
                Math.abs(position.current.offset - before.offset) < 0.001;

            if (
                bounded &&
                stuck &&
                driftingRef.current &&
                Math.sign(driftVelocity.current) === driftDirection.current &&
                Math.abs(driftVelocity.current) > 1
            ) {
                driftDirection.current = driftDirection.current === 1 ? -1 : 1;
                driftVelocity.current = 0;
                driftRestUntil.current = now + END_REST_MS;
            }

            // Fetch far ahead; mount only what is close.
            const ahead = placeBlocks(
                position.current,
                heightOf,
                currentSpan,
                viewport,
                viewport * FETCH_AHEAD,
                viewport * FETCH_AHEAD
            );

            for (const block of ahead.missing) {
                fetchPage(pageOfBlock(block, currentSpan));
            }

            const placed = placeBlocks(
                position.current,
                heightOf,
                currentSpan,
                viewport,
                viewport * MOUNT_BEFORE,
                viewport * (1 + MOUNT_AFTER)
            );

            tops.current.clear();

            for (const { block, top } of placed.blocks) {
                tops.current.set(block, top);
            }

            const base = placed.blocks[0];

            // A wall shorter than the screen sits in the middle of it rather than at the top.
            const only = currentSpan.pageCount === 1 ? heightOf(0) : undefined;
            const centring =
                !currentSpan.wrap && only !== undefined && only < viewport
                    ? (viewport - only) / 2
                    : 0;

            // Rows in the window, and which of them are on screen.
            const keys: string[] = [];
            const rows: RenderRow[] = [];

            tilesRef.current.clear();

            for (const { block, top } of placed.blocks) {
                const page = pageOfBlock(block, currentSpan);
                const layout = layouts.current.get(page);
                const items = pages.current.get(page);

                if (!layout || !items) continue;

                layout.rows.forEach((row, index) => {
                    const rowTop = top + row.y + centring;

                    if (
                        rowTop + row.height < -viewport * MOUNT_BEFORE ||
                        rowTop > viewport * (1 + MOUNT_AFTER)
                    ) {
                        return;
                    }

                    // The rows that play: the middle of the screen, not the edges. A row half
                    // out of frame should not hold a decoder a row in full view is waiting for.
                    const central = rowTop + row.height > viewport * 0.2 && rowTop < viewport * 0.8;
                    const key = `${block}:${index}`;

                    keys.push(`${key}${central ? "c" : ""}`);
                    rows.push({
                        key,
                        top: rowTop - base.top,
                        height: row.height,
                        tiles: row.tiles.map((tile) => ({
                            item: items[tile.index],
                            x: tile.x,
                            width: tile.width,
                        })),
                        central,
                        page,
                    });

                    for (const tile of row.tiles) {
                        const item = items[tile.index];

                        tilesRef.current.set(`${key}:${item.id}`, {
                            item,
                            top: rowTop,
                            height: row.height,
                        });
                    }
                });
            }

            const nextSignature = `${base?.block}|${keys.join(",")}`;

            if (base && nextSignature !== signature.current) {
                signature.current = nextSignature;
                renderedBase.current = base.block;
                setFrame({ base: base.block, rows });
            }

            const baseTop = tops.current.get(renderedBase.current);

            if (baseTop !== undefined && layerRef.current) {
                layerRef.current.style.transform = `translate3d(0, ${baseTop}px, 0)`;
            }

            // Let go of pages far behind or ahead; they come back from the query cache.
            const anchorPage = pageOfBlock(position.current.block, currentSpan);
            const count = currentSpan.pageCount;

            for (const page of pages.current.keys()) {
                const distance = count
                    ? Math.min(Math.abs(page - anchorPage), count - Math.abs(page - anchorPage))
                    : Math.abs(page - anchorPage);

                if (distance > KEEP_PAGES) {
                    pages.current.delete(page);
                    layouts.current.delete(page);
                }
            }
        };

        raf = requestAnimationFrame(step);

        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [size.height, driftSpeed, fetchPage]);

    // The layer's transform belongs to the base block that was rendered, so it is set again
    // the moment a new base commits rather than waiting a frame and showing the old offset.
    useLayoutEffect(() => {
        const baseTop = tops.current.get(frame.base);

        if (baseTop !== undefined && layerRef.current) {
            layerRef.current.style.transform = `translate3d(0, ${baseTop}px, 0)`;
        }
    }, [frame]);

    // --- Input ---
    useEffect(() => {
        const stage = stageRef.current;

        if (!stage) return;

        const touched = () => {
            lastInput.current = performance.now();
            momentum.current = 0;
            // Any gesture is the one the browser wanted before it would play with sound.
            unlockRef.current();
        };

        const onWheel = (event: WheelEvent) => {
            touched();
            wheelPending.current += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        };

        const onPointerDown = (event: PointerEvent) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;

            noteTapStart(event);
            touched();
            drag.current = {
                id: event.pointerId,
                lastY: event.clientY,
                lastT: performance.now(),
                velocity: 0,
                moved: false,
            };
        };

        const onPointerMove = (event: PointerEvent) => {
            const current = drag.current;

            if (!current || current.id !== event.pointerId) return;

            const dy = event.clientY - current.lastY;
            const now = performance.now();

            if (!current.moved && Math.abs(dy) < 6) return;

            if (!current.moved) {
                current.moved = true;
                // Captured only once it is a drag, so a plain click still lands on its tile.
                stage.setPointerCapture(event.pointerId);
            }

            const dt = Math.max(1, now - current.lastT) / 1000;

            current.velocity = current.velocity * 0.6 + (-dy / dt) * 0.4;
            current.lastY = event.clientY;
            current.lastT = now;
            position.current = {
                ...position.current,
                offset: position.current.offset - dy,
            };
        };

        const onPointerUp = (event: PointerEvent) => {
            const current = drag.current;

            if (!current || current.id !== event.pointerId) return;

            if (current.moved) {
                // A pause before letting go is a stop, not a flick.
                momentum.current = performance.now() - current.lastT < 80 ? current.velocity : 0;
                suppressClick.current = true;
                setTimeout(() => {
                    suppressClick.current = false;
                }, 0);
            }

            drag.current = null;
        };

        const onKey = (event: KeyboardEvent) => {
            // The sound menu's own keys — Space on its switches, Escape to close it — are its.
            if (soundOpenRef.current) return;

            const page = stage.clientHeight * 0.8;
            const moves: Record<string, number> = {
                ArrowDown: 140,
                ArrowUp: -140,
                PageDown: page,
                PageUp: -page,
                " ": event.shiftKey ? -page : page,
            };

            if (event.key in moves) {
                event.preventDefault();
                touched();
                wheelPending.current += moves[event.key];
            } else if (event.key === "Escape" && !document.fullscreenElement) {
                onExit();
            } else if (event.key === "f" || event.key === "F") {
                toggleFullscreen();
            } else if (event.key === "s" || event.key === "S") {
                touched();
                soundKeysRef.current.setSound(!soundKeysRef.current.sound);
            } else if (event.key === "m" || event.key === "M") {
                touched();
                soundKeysRef.current.setMuted(!soundKeysRef.current.muted);
            }
        };

        stage.addEventListener("wheel", onWheel, { passive: true });
        stage.addEventListener("pointerdown", onPointerDown);
        stage.addEventListener("pointermove", onPointerMove);
        stage.addEventListener("pointerup", onPointerUp);
        stage.addEventListener("pointercancel", onPointerUp);
        document.addEventListener("keydown", onKey);

        return () => {
            stage.removeEventListener("wheel", onWheel);
            stage.removeEventListener("pointerdown", onPointerDown);
            stage.removeEventListener("pointermove", onPointerMove);
            stage.removeEventListener("pointerup", onPointerUp);
            stage.removeEventListener("pointercancel", onPointerUp);
            document.removeEventListener("keydown", onKey);
        };
    }, [onExit, noteTapStart]);

    // Any pointer movement over the wall counts as looking at it.
    useEffect(() => {
        const stage = stageRef.current;

        if (!stage) return;

        const onMove = () => {
            lastInput.current = performance.now();
        };
        const onOver = (event: PointerEvent) => {
            pointedRef.current = (event.target as Element | null)?.closest("a") !== null;
        };

        stage.addEventListener("pointermove", onMove, { passive: true });
        stage.addEventListener("pointerover", onOver, { passive: true });

        return () => {
            stage.removeEventListener("pointermove", onMove);
            stage.removeEventListener("pointerover", onOver);
        };
    }, []);

    /**
     * Opening a tile: remember where the wall was, so coming back from the player lands here
     * rather than at the first page.
     */
    const onOpen = useCallback(
        (event: React.MouseEvent, tilePage: number) => {
            // Consumed first, so a drag that began as a waking tap does not leave it set.
            const onlyWoke = tapOnlyWoke();

            if (suppressClick.current || onlyWoke) {
                event.preventDefault();
                return;
            }

            const page = pageOfBlock(position.current.block, span());
            const height = layouts.current.get(page)?.height;

            saveShowcasePosition({
                filter,
                page,
                fraction: height ? position.current.offset / height : 0,
            });

            /**
             * The address, and the page the opened tile sits on.
             *
             * The viewer reads this to know which set it is in and where, so that it can
             * offer the next item and warm it. The showcase itself ignores `page` — its own
             * position is restored from the entry above, or from the viewer's rewrite of it
             * on the way back — so recording it costs nothing.
             */
            const address = new URLSearchParams(window.location.search);

            address.set("page", String(tilePage));
            rememberReturnTo(`${window.location.pathname}?${address.toString()}`);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [filter, tapOnlyWoke]
    );

    const loading = frame.rows.length === 0 && pageCount !== 0;

    return (
        <div
            ref={stageRef}
            className={classes.stage}
            data-idle={controlsIdle || undefined}
            data-drifting={drifting || undefined}
            data-voicing={voice.liveKey !== null || undefined}
            onDragStart={(event) => event.preventDefault()}
        >
            <div ref={layerRef} className={classes.layer}>
                {/* One flat list, not a list of rows. Nested, each row's tiles are keyed only
                    within their row, and the row itself by its position — so a row drifting off
                    the top shifted every row below it, React remounted every tile on the wall,
                    and each one replayed its arrival fade and restarted its clip. */}
                {frame.rows.flatMap((row) =>
                    row.tiles.map((tile) => (
                        <ShowcaseTile
                            key={`${row.key}:${tile.item.id}`}
                            item={tile.item}
                            x={tile.x}
                            y={row.top}
                            width={tile.width}
                            height={row.height}
                            autoplay={row.central}
                            drifting={drifting}
                            page={row.page}
                            onOpen={onOpen}
                            voice={voice.voiceFor(`${row.key}:${tile.item.id}`)}
                            voiceHandlers={voice.handlers}
                            voicePositionRef={voice.positionRef}
                        />
                    ))
                )}
            </div>

            {loading && (
                <div className={classes.centre}>
                    <Loader color="brass" type="dots" />
                </div>
            )}

            {pageCount === 0 && (
                <div className={classes.centre}>
                    <Text c="dimmed" size="sm">
                        Nothing here to show.
                    </Text>
                </div>
            )}

            {voice.refused && (
                <button type="button" className={classes.unlock} onClick={voice.unlock}>
                    <SoundGlyph size={16} />
                    Tap for sound
                </button>
            )}

            <div className={classes.chrome}>
                <ShowcaseSoundMenu
                    opened={soundOpen}
                    onOpened={setSoundOpen}
                    sound={sound}
                    onSound={setSound}
                    muted={muted}
                    onMuted={setMuted}
                    clipSeconds={clipSeconds}
                    onClipSeconds={setClipSeconds}
                />
                <Tooltip label="Full screen (F)" position="bottom">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        radius="xl"
                        aria-label="Toggle full screen"
                        onClick={toggleFullscreen}
                    >
                        <FullscreenGlyph />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Close (Esc)" position="bottom">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        radius="xl"
                        aria-label="Close the showcase"
                        onClick={onExit}
                    >
                        <CloseGlyph />
                    </ActionIcon>
                </Tooltip>
            </div>
        </div>
    );
};
