"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MutableRefObject,
} from "react";

import type { MediaTokens } from "@private-stock/core";

import { loadCastSdk } from "./castSdk";

/**
 * The Cast session, for the whole app (§11, casting).
 *
 * In the layout rather than the player because a cast outlives the page that started it: Next
 * and Prev move to another item page, and the TV has to stay connected through that, as it does
 * when the phone sleeps and the tab is reopened later -- the SDK rejoins the session by itself
 * (`ORIGIN_SCOPED`) and this is where that is noticed.
 *
 * The receiver is Google's Default Media Receiver: it plays a URL it is given, which is all this
 * needs, and it means there is no receiver app of ours to host or register.
 */

export type CastLink = MediaTokens["links"][number];

/** What the TV is doing, as far as the sender knows. */
export interface TvState {
    /** The item it has loaded, from the `customData` we sent with it; null when it has none. */
    mediaId: string | null;
    playing: boolean;
    positionMs: number;
    durationMs: number;
    muted: boolean;
    /** The item played to its end and the TV stopped there -- the end of a queue, or of one item. */
    finished: boolean;
}

/**
 * Bookkeeping that belongs to the session rather than to any one page.
 *
 * `agreedId` is the item the page and the TV last agreed on (see `castQueue.ts`). `queuedIds` is
 * the queue as this tab built it. `refused` is what the server declined to cast, so it is not
 * asked again. `leaving` is the item the TV was just told to leave: for a moment after a load
 * the TV still reports it, and that must not read as the TV having moved there by itself.
 * `finished` is what has been reported as played to the end since the queue was loaded -- a
 * finish counts a view, so each is reported once.
 */
export interface CastBook {
    agreedId: string | null;
    queuedIds: string[];
    refused: Set<string>;
    leaving: string | null;
    finished: Set<string>;
}

interface CastValue {
    /** The SDK is up and a TV can be reached. */
    available: boolean;
    connected: boolean;
    deviceName: string | null;
    tv: TvState;
    book: MutableRefObject<CastBook>;
    /** A load or top-up is in flight; the page leaves the TV alone until it settles. */
    busy: boolean;
    setBusy: (busy: boolean) => void;
    connect: () => Promise<boolean>;
    disconnect: () => void;
    /** Replace whatever the TV has with these, starting the first at `startMs`. */
    play: (links: CastLink[], startMs: number) => Promise<void>;
    /** Add these to the end of the TV's queue. */
    append: (links: CastLink[]) => Promise<void>;
    /** Drop whatever is queued after the item playing. */
    trimAfterCurrent: () => void;
    togglePlay: () => void;
    seekTo: (ms: number) => void;
    toggleMute: () => void;
    /** Stop the TV's media, keeping the session. */
    stopMedia: () => void;
}

const IDLE_TV: TvState = {
    mediaId: null,
    playing: false,
    positionMs: 0,
    durationMs: 0,
    muted: false,
    finished: false,
};

const emptyBook = (): CastBook => ({
    agreedId: null,
    queuedIds: [],
    refused: new Set(),
    leaving: null,
    finished: new Set(),
});

const CastContext = createContext<CastValue | null>(null);

/** The address a TV fetches: the configured cast port, or this page's own origin. */
const castUrl = (link: CastLink): string =>
    link.url ?? new URL(link.path, window.location.origin).href;

const queueItemFor = (link: CastLink, startMs: number): chrome.cast.media.QueueItem => {
    const info = new chrome.cast.media.MediaInfo(castUrl(link), link.contentType);

    info.streamType = chrome.cast.media.StreamType.BUFFERED;
    // How the TV's item is recognised again -- the URL carries a token that changes per mint.
    info.customData = { mediaId: link.mediaId };

    const item = new chrome.cast.media.QueueItem(info);

    item.autoplay = true;
    item.startTime = startMs / 1000;

    return item;
};

/** The SDK's callback-style calls, as promises. */
const call = (run: (done: () => void, fail: (error: chrome.cast.Error) => void) => void) =>
    new Promise<void>((resolve, reject) => run(resolve, reject));

const mediaIdOf = (info: chrome.cast.media.MediaInfo | null | undefined): string | null => {
    const data: unknown = info?.customData;

    return data && typeof data === "object" && "mediaId" in data && typeof data.mediaId === "string"
        ? data.mediaId
        : null;
};

export const CastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [castState, setCastState] = useState<string | null>(null);
    const [tv, setTv] = useState<TvState>(IDLE_TV);
    const [deviceName, setDeviceName] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const book = useRef<CastBook>(emptyBook());
    const playerRef = useRef<{
        player: cast.framework.RemotePlayer;
        controller: cast.framework.RemotePlayerController;
    } | null>(null);

    useEffect(() => {
        let cancelled = false;
        let unbind = () => undefined as void;

        void loadCastSdk().then((ok) => {
            if (!ok || cancelled) return;

            const context = cast.framework.CastContext.getInstance();

            context.setOptions({
                receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            });

            const player = new cast.framework.RemotePlayer();
            const controller = new cast.framework.RemotePlayerController(player);

            playerRef.current = { player, controller };

            const read = () => {
                const session = context.getCurrentSession();
                // The media session, for what the remote player does not carry: why it went idle,
                // and which item it was on when it did -- the player can drop its media info then.
                const media = session?.getMediaSession() ?? null;
                const finished =
                    media?.playerState === chrome.cast.media.PlayerState.IDLE &&
                    media.idleReason === chrome.cast.media.IdleReason.FINISHED;

                setDeviceName(session?.getCastDevice().friendlyName ?? null);
                setTv(
                    player.isConnected
                        ? {
                              mediaId: mediaIdOf(player.mediaInfo) ?? mediaIdOf(media?.media),
                              playing:
                                  !player.isPaused &&
                                  player.playerState !== chrome.cast.media.PlayerState.IDLE,
                              positionMs: player.currentTime * 1000,
                              durationMs: player.duration * 1000,
                              muted: player.isMuted,
                              finished,
                          }
                        : IDLE_TV
                );
            };

            const onState = (event: cast.framework.CastStateEventData) => {
                setCastState(event.castState);

                // A session that ended, from here or from the TV's own remote, takes its
                // bookkeeping with it.
                if (event.castState !== cast.framework.CastState.CONNECTED) {
                    book.current = emptyBook();
                }

                read();
            };

            context.addEventListener(
                cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                onState
            );
            controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, read);
            setCastState(context.getCastState());
            read();

            unbind = () => {
                context.removeEventListener(
                    cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                    onState
                );
                controller.removeEventListener(
                    cast.framework.RemotePlayerEventType.ANY_CHANGE,
                    read
                );
            };
        });

        return () => {
            cancelled = true;
            unbind();
        };
    }, []);

    const connect = useCallback(async () => {
        try {
            await cast.framework.CastContext.getInstance().requestSession();
        } catch {
            // Closing the device picker is a rejection; it is not an error worth reporting.
        }

        return cast.framework.CastContext.getInstance().getCurrentSession() !== null;
    }, []);

    const disconnect = useCallback(() => {
        book.current = emptyBook();
        cast.framework.CastContext.getInstance().endCurrentSession(true);
    }, []);

    const play = useCallback(async (links: CastLink[], startMs: number) => {
        const session = cast.framework.CastContext.getInstance().getCurrentSession();

        if (!session) throw new Error("No cast session");

        const items = links.map((link, index) => queueItemFor(link, index === 0 ? startMs : 0));
        const request = new chrome.cast.media.QueueLoadRequest(items);

        request.startIndex = 0;
        request.repeatMode = chrome.cast.media.RepeatMode.OFF;

        await call((done, fail) => session.getSessionObj().queueLoad(request, done, fail));
        book.current.queuedIds = links.map((link) => link.mediaId);
        // A new queue: the same item may be played to the end again, and that is another view.
        book.current.finished = new Set();
    }, []);

    const append = useCallback(async (links: CastLink[]) => {
        const media = cast.framework.CastContext.getInstance()
            .getCurrentSession()
            ?.getMediaSession();

        if (!media || links.length === 0) return;

        const request = new chrome.cast.media.QueueInsertItemsRequest(
            links.map((link) => queueItemFor(link, 0))
        );

        await call((done, fail) => media.queueInsertItems(request, done, fail));
        book.current.queuedIds = [...book.current.queuedIds, ...links.map((link) => link.mediaId)];
    }, []);

    const trimAfterCurrent = useCallback(() => {
        const media = cast.framework.CastContext.getInstance()
            .getCurrentSession()
            ?.getMediaSession();

        if (!media) return;

        const items = media.items ?? [];
        const at = items.findIndex((item) => item.itemId === media.currentItemId);

        // One at a time: the batch call exists but is missing from the SDK's published types.
        for (const item of at === -1 ? [] : items.slice(at + 1)) {
            media.queueRemoveItem(
                item.itemId,
                () => undefined,
                () => undefined
            );
        }

        const current = mediaIdOf(media.media);
        const kept = current ? book.current.queuedIds.indexOf(current) : -1;

        book.current.queuedIds = kept === -1 ? [] : book.current.queuedIds.slice(0, kept + 1);
    }, []);

    const togglePlay = useCallback(() => playerRef.current?.controller.playOrPause(), []);
    const toggleMute = useCallback(() => playerRef.current?.controller.muteOrUnmute(), []);
    const stopMedia = useCallback(() => playerRef.current?.controller.stop(), []);

    const seekTo = useCallback((ms: number) => {
        const remote = playerRef.current;

        if (!remote) return;

        remote.player.currentTime = ms / 1000;
        remote.controller.seek();
        // The bar moves now rather than when the TV next reports, so a tap feels like a tap.
        setTv((current) => ({ ...current, positionMs: ms }));
    }, []);

    const value = useMemo<CastValue>(
        () => ({
            // The SDK's `CastState` values, as strings: `cast` is not defined until the SDK has
            // loaded, and this runs before it has.
            available: castState !== null && castState !== "NO_DEVICES_AVAILABLE",
            connected: castState === "CONNECTED",
            deviceName,
            tv,
            book,
            busy,
            setBusy,
            connect,
            disconnect,
            play,
            append,
            trimAfterCurrent,
            togglePlay,
            seekTo,
            toggleMute,
            stopMedia,
        }),
        [
            castState,
            deviceName,
            tv,
            busy,
            connect,
            disconnect,
            play,
            append,
            trimAfterCurrent,
            togglePlay,
            seekTo,
            toggleMute,
            stopMedia,
        ]
    );

    return <CastContext.Provider value={value}>{children}</CastContext.Provider>;
};

/** The session, or null outside the provider. */
export const useCast = (): CastValue | null => useContext(CastContext);
