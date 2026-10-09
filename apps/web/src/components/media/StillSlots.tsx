"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { assignSlots, initialSlots } from "@/lib/videoSlots";
import { mayWarmNextItem } from "@/lib/videoWarming";
import { transitionFor } from "@/lib/stillTransition";
import { stillProbe, useWarmReport } from "@/lib/useWarmReport";
import type { WarmGate, WarmSource } from "@/lib/warmMonitor";

import classes from "./StillSlots.module.scss";

/**
 * Two pictures, one of them showing (§14b).
 *
 * The arithmetic from `videoSlots.ts`, unchanged, for a different payoff. There it keeps a
 * buffer alive across a change of item; here it means the next picture is already decoded in
 * the other slot, so arriving at it is a change of which slot is active and the crossfade has
 * something to fade *from* as well as to. A picture nobody saw coming -- a jump in from the
 * grid, or a device that refused the bandwidth -- overwrites the slot on screen and cuts, which
 * is the honest answer when there is no decoded replacement in hand.
 *
 * Out of `StillStage` so the tasting (§14g) can put the same pictures on its own stage: the
 * slots, the decode and the failure are the part both need, and the plate, the clock and the
 * transport around them are not.
 *
 * Renders only the `<img>` elements, absolutely positioned: the caller supplies the box.
 */

interface StillSlotsProps {
    mediaId: string;
    /** The picture, or null when there is none to show. */
    src: string | null;
    alt: string;
    /** The next picture worth decoding early, and the id it belongs to. */
    preloadMediaId: string | null;
    preloadSrc: string | null;
    /**
     * The picture on show for `mediaId` can be painted.
     *
     * Named by id, and it can arrive more than once: the caller decides which arrival it
     * belongs to, because only the caller knows whether that id is the one on stage.
     */
    onPaintable: (mediaId: string) => void;
    /** The picture on show for `mediaId` will not decode. */
    onFailed: (mediaId: string) => void;
    /** The picture's natural shape, as a CSS `aspect-ratio` value. */
    onAspect?: (aspect: string) => void;
    /** Which stage this is, for the warming overlay (§8b, "Seeing it work"). */
    warmSource?: WarmSource;
    /**
     * Laid out but not yet showing, for the overlay's sake only: the tasting decodes the next
     * picture in a hidden layer (§14g), and its join is when that layer is lit, not when it
     * mounted.
     */
    cued?: boolean;
}

export const StillSlots: React.FC<StillSlotsProps> = ({
    mediaId,
    src,
    alt,
    preloadMediaId,
    preloadSrc,
    onPaintable,
    onFailed,
    onAspect,
    warmSource = "still",
    cued = false,
}) => {
    const [mayWarm, setMayWarm] = useState(false);

    // Asked once, after mount: it reads `navigator.connection`, which does not exist on the
    // server (§8b).
    useEffect(() => setMayWarm(mayWarmNextItem()), []);

    // Off the render path, so `ready` changes identity only with the arrival -- a fresh ref
    // callback is called again by React, and that is a second `begin` for nothing.
    const paintableRef = useRef(onPaintable);
    const aspectRef = useRef(onAspect);

    paintableRef.current = onPaintable;
    aspectRef.current = onAspect;

    /**
     * Written during render, not in an effect: a picture that is already decoded in the other
     * slot has to become visible in the same commit that changed `mediaId`, or the show blinks
     * through the well colour on every advance. `assignSlots` returns the object it was given
     * when nothing moves, so this is stable across renders.
     */
    const slotsRef = useRef(initialSlots(mediaId));
    const previousSlots = slotsRef.current;

    slotsRef.current = assignSlots(
        slotsRef.current,
        mediaId,
        mayWarm && preloadSrc !== null ? preloadMediaId : null
    );

    const slots = slotsRef.current;

    /**
     * The elements by the id they hold, for the overlay to look at. Written by ref callbacks and
     * never cleared on a detach -- the getters below ask whether the element is still in the
     * document instead, which is the same answer without depending on React's detach order.
     */
    const imagesRef = useRef(new Map<string, HTMLImageElement>());
    const keepImage = useCallback((element: HTMLImageElement | null) => {
        if (element?.dataset.arrival) {
            imagesRef.current.set(element.dataset.arrival, element);
        }
    }, []);
    const imageFor = (id: string | null): HTMLImageElement | null => {
        const element = id === null ? undefined : imagesRef.current.get(id);

        return element?.isConnected ? element : null;
    };

    const warmGate: WarmGate = !mayWarm
        ? "refused"
        : preloadMediaId === null || preloadSrc === null
          ? "none"
          : preloadMediaId === mediaId
            ? "same-file"
            : "warming";

    useWarmReport({
        source: warmSource,
        probe: stillProbe,
        mediaId,
        arrival: mediaId,
        held: cued,
        slots: previousSlots,
        targetMs: null,
        offered: preloadMediaId === null ? null : { id: preloadMediaId, startMs: null },
        gate: warmGate,
        live: () => imageFor(slots.ids[slots.active]),
        warming: () => imageFor(slots.ids[slots.active === 0 ? 1 : 0]),
    });

    const sourceFor = (slotId: string): string | null =>
        slotId === mediaId ? src : slotId === preloadMediaId ? preloadSrc : null;

    /**
     * The clock starts when the picture can be painted, not when the element mounts.
     *
     * These are original files on a NAS. A photograph whose bytes took four seconds to arrive
     * would otherwise be shown for one -- the feature failing in exactly the conditions it exists
     * for. `complete` covers the case that matters most and is easiest to miss: a picture decoded
     * in the other slot has already fired `load` and will never fire it again.
     */
    const ready = useCallback(
        (element: HTMLImageElement | null) => {
            keepImage(element);

            if (!element || element.dataset.arrival !== mediaId) {
                return;
            }

            if (element.naturalWidth > 0 && element.naturalHeight > 0) {
                aspectRef.current?.(`${element.naturalWidth} / ${element.naturalHeight}`);
            }

            if (element.complete) {
                paintableRef.current(mediaId);
            }
        },
        [mediaId, keepImage]
    );

    return (
        <>
            {slots.ids.map((slotId, index) => {
                const slotSrc = slotId === null ? null : sourceFor(slotId);

                if (slotId === null || slotSrc === null) {
                    return null;
                }

                const live = index === slots.active;

                return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        key={slotId}
                        src={slotSrc}
                        alt={live ? alt : ""}
                        // Read back in `ready`, so a `load` for a picture already walked past
                        // cannot arm a clock or reshape the frame.
                        data-arrival={slotId}
                        className={classes.picture}
                        data-active={live || undefined}
                        data-transition={transitionFor(slotId)}
                        // Only the live one lights the room (§14b, `useSpillLight`). The other
                        // slot holds a picture nobody can see yet.
                        data-spill={live || undefined}
                        aria-hidden={live ? undefined : true}
                        decoding="async"
                        fetchPriority={live ? "high" : "low"}
                        ref={live ? ready : keepImage}
                        onLoad={live ? (event) => ready(event.currentTarget) : undefined}
                        onError={live ? () => onFailed(slotId) : undefined}
                    />
                );
            })}
        </>
    );
};
