"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useCastLinks } from "@/lib/api/media";

import { castSync, idsToQueue } from "./castQueue";
import { useCast } from "./CastProvider";

/** The TV, as the player bar drives it. */
export interface CastRemote {
    playing: boolean;
    positionMs: number;
    durationMs: number;
    muted: boolean;
    togglePlay: () => void;
    seekTo: (ms: number) => void;
    toggleMute: () => void;
}

/** What the player needs to offer casting and, while casting, to be the TV's remote. */
export interface CastControl {
    /** A session is up: the bar drives the TV, and the picture here stays still. */
    active: boolean;
    deviceName: string | null;
    /** Why this item cannot be cast, shown instead of casting it. */
    blocked: string | null;
    /** What went wrong on the way to the TV, if anything did. */
    message: string | null;
    remote: CastRemote;
    /** Connect if need be, and play this item on the TV from `positionMs`. */
    start: (positionMs: number) => void;
    /** End the session; answers where the TV had got to, to carry on from here. */
    stop: () => number;
}

interface CastItemOptions {
    mediaId: string;
    /** Why this item cannot be cast, or null when it can. */
    blocked: string | null;
    /** The items after this one in the set, in order (`useViewerSequence`). */
    upcomingIds: readonly string[];
    /** The page's "play the next one" switch: a queue on the TV when on, one item when off. */
    autoplayNext: boolean;
    /** Move the page to the item the TV has moved on to. */
    follow: (mediaId: string) => void;
}

/**
 * One item page's half of casting (§11): keeping the TV and the page on the same item, and the
 * TV's queue full enough to carry on while the phone is asleep.
 *
 * The rules for which side moves are in `castQueue.ts`. This applies them: sending the TV the
 * page's item when the page moved, moving the page when the TV did, topping the queue up from
 * the set's look-ahead, and trimming it when continuous play is switched off.
 *
 * Null where there is nothing to cast to -- no Cast in this browser, or no TV on the network --
 * so the player shows no control at all rather than one that cannot work.
 */
export const useCastItem = ({
    mediaId,
    blocked,
    upcomingIds,
    autoplayNext,
    follow,
}: CastItemOptions): CastControl | null => {
    const cast = useCast();
    const mint = useCastLinks();
    const [message, setMessage] = useState<string | null>(null);

    // The latest of everything the asynchronous steps read, so a load that finishes after the
    // page has moved on acts on where the page is now, not where it was.
    const latest = useRef({ mediaId, blocked, upcomingIds, autoplayNext, follow, mint, cast });

    latest.current = { mediaId, blocked, upcomingIds, autoplayNext, follow, mint, cast };

    useEffect(() => setMessage(null), [mediaId]);

    /** Send this page's item to the TV -- with what follows it, when continuous play is on. */
    const load = useCallback(async (startMs: number) => {
        const { cast: session, mint: links, ...page } = latest.current;

        if (!session) return;

        const book = session.book.current;

        session.setBusy(true);
        book.leaving = session.tv.mediaId;

        // Agreed before anything is sent, failure included: the TV is about to be on this item
        // or on nothing, and either way the page must not be pulled back to the one it left.
        book.agreedId = page.mediaId;

        try {
            if (page.blocked) {
                session.stopMedia();
                setMessage(page.blocked);

                return;
            }

            const ids = page.autoplayNext ? [page.mediaId, ...page.upcomingIds] : [page.mediaId];
            const { links: minted } = await links.mutateAsync(ids.slice(0, 20));
            const granted = new Set(minted.map((link) => link.mediaId));

            ids.filter((id) => !granted.has(id)).forEach((id) => book.refused.add(id));

            if (minted[0]?.mediaId !== page.mediaId) {
                session.stopMedia();
                setMessage("This item can't be played on a TV yet.");

                return;
            }

            await session.play(minted, startMs);
        } catch {
            session.stopMedia();
            setMessage("The TV couldn't start this item.");
        } finally {
            session.setBusy(false);
        }
    }, []);

    const connected = cast?.connected ?? false;
    const busy = cast?.busy ?? false;
    const tvId = cast?.tv.mediaId ?? null;

    // Keep the two in step: send the TV here, or move the page to the TV.
    useEffect(() => {
        const session = latest.current.cast;

        if (!session || !connected || busy) return;

        const book = session.book.current;

        if (tvId === book.agreedId) {
            book.leaving = null;
        }

        const action = castSync(mediaId, tvId, book.agreedId);

        if (action.kind === "load") {
            void load(0);
        } else if (action.kind === "follow" && action.mediaId !== book.leaving) {
            book.agreedId = action.mediaId;
            latest.current.follow(action.mediaId);
        }
    }, [connected, busy, tvId, mediaId, load]);

    // Keep enough queued that the TV carries on while the phone sleeps.
    const upcomingKey = upcomingIds.join(",");

    useEffect(() => {
        const session = latest.current.cast;

        if (!session || !connected || busy || !autoplayNext || tvId !== mediaId) return;

        const book = session.book.current;
        const ids = idsToQueue(latest.current.upcomingIds, book.queuedIds, mediaId, book.refused);

        if (ids.length === 0) return;

        session.setBusy(true);
        latest.current.mint
            .mutateAsync(ids)
            .then(async ({ links }) => {
                const granted = new Set(links.map((link) => link.mediaId));

                ids.filter((id) => !granted.has(id)).forEach((id) => book.refused.add(id));
                await session.append(links);
            })
            // A queue that could not be topped up still plays what it has; the next check tries
            // again.
            .catch(() => undefined)
            .finally(() => session.setBusy(false));
    }, [connected, busy, autoplayNext, tvId, mediaId, upcomingKey]);

    // Continuous play switched off mid-cast: the TV stops after the item it is on.
    useEffect(() => {
        const session = latest.current.cast;

        if (session?.connected && !autoplayNext) {
            session.trimAfterCurrent();
        }
    }, [autoplayNext]);

    const start = useCallback(
        (positionMs: number) => {
            const session = latest.current.cast;

            if (!session) return;

            setMessage(null);
            // Busy through the device picker, so the sync above does not start the item from
            // the top while the person is still choosing a TV.
            session.setBusy(true);
            void session
                .connect()
                .then((ok) => (ok ? load(positionMs) : undefined))
                .finally(() => session.setBusy(false));
        },
        [load]
    );

    if (!cast || (!cast.available && !cast.connected)) {
        return null;
    }

    return {
        active: cast.connected,
        deviceName: cast.deviceName,
        blocked,
        message,
        remote: {
            playing: cast.tv.playing,
            positionMs: cast.tv.positionMs,
            durationMs: cast.tv.durationMs,
            muted: cast.tv.muted,
            togglePlay: cast.togglePlay,
            seekTo: cast.seekTo,
            toggleMute: cast.toggleMute,
        },
        start,
        stop: () => {
            const at = cast.tv.positionMs;

            cast.disconnect();

            return at;
        },
    };
};
