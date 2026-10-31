"use client";

import { useCallback, useEffect, useState } from "react";

import {
    DEFAULT_SKIP_BACK,
    DEFAULT_SKIP_FORWARD,
    snapSkipBack,
    snapSkipForward,
    type SkipBackSeconds,
    type SkipForwardSeconds,
} from "./skipLengths";
import { DEFAULT_DWELL, snapDwellSeconds, type DwellSeconds } from "./stageDwell";
import {
    DEFAULT_CLIP_SECONDS,
    DEFAULT_PHOTO_SECONDS,
    snapTastingSeconds,
    type TastingSeconds,
} from "./tasting/lengths";

/**
 * Playback preferences, per device (§14b).
 *
 * `localStorage`, not `UserPref`. Autoplay on the sofa and silence on the train is the common
 * case, and it is a fact about where you are rather than about who you are — so the phone and
 * the desktop are allowed to disagree, and nothing syncs.
 *
 * Every access is wrapped: a private window, disabled site data, or a quota error all throw,
 * and a preference that cannot be stored must degrade to its default rather than take the
 * player down.
 */

const KEYS = {
    autoplayOnOpen: "ps:autoplayOnOpen",
    autoplayNext: "ps:autoplayNext",
    muted: "ps:muted",
    showcaseSound: "ps:showcaseSound",
} as const;

export type PlaybackPref = keyof typeof KEYS;

/**
 * What each preference does when nothing has been stored.
 *
 * Opening an item plays it: that was the explicit choice, on the grounds that you opened the
 * item in order to watch it. Rolling on to the *next* item is not — finishing one thing is
 * not consent to start another, and a library that keeps playing after you have walked away
 * is how an evening ends with the third season of something nobody chose.
 */
const DEFAULTS: Record<PlaybackPref, boolean> = {
    autoplayOnOpen: true,
    autoplayNext: false,
    /**
     * Sound, until somebody says otherwise.
     *
     * Not the same decision as §14b's refusal to start muted for the autoplay policy: that
     * was about muting on the browser's behalf, without being asked, to make autoplay work.
     * This is a preference a person expressed by pressing the mute button, and carrying it to
     * the next item is what makes it a preference rather than a per-video accident.
     */
    muted: false,
    /**
     * The showcase's voice (§14f), off until asked for. Opening a wall of pictures is not a
     * request for sound, where opening a film is.
     */
    showcaseSound: false,
};

const read = (pref: PlaybackPref): boolean => {
    try {
        const stored = localStorage.getItem(KEYS[pref]);

        return stored === null ? DEFAULTS[pref] : stored === "1";
    } catch {
        return DEFAULTS[pref];
    }
};

/**
 * The stored value, right now.
 *
 * Exported for the one caller that cannot wait for the hook: `usePlaybackPref` reads after
 * mount, so its first value is always the default, and a video that starts playing in that
 * gap would be briefly audible to somebody who had asked for silence. Safe to call from an
 * effect; never during a render, for the hydration reason the hook documents.
 */
export const readPlaybackPref = (pref: PlaybackPref): boolean => read(pref);

const write = (pref: PlaybackPref, value: boolean): void => {
    try {
        localStorage.setItem(KEYS[pref], value ? "1" : "0");
    } catch {
        // Nothing to do and nothing worth saying: the setting simply does not persist, and
        // the toggle still works for this page.
    }
};

/**
 * A preference, and a way to change it.
 *
 * Read after mount rather than during the first render. The server has no `localStorage`, so
 * reading it while rendering would make the server and the client disagree about the initial
 * markup — React calls that a hydration error and throws away the tree. The first paint uses
 * the default, and the stored value arrives immediately afterwards.
 */
export const usePlaybackPref = (pref: PlaybackPref): [boolean, (value: boolean) => void] => {
    const [value, setValue] = useState(DEFAULTS[pref]);

    useEffect(() => {
        setValue(read(pref));
    }, [pref]);

    const update = useCallback(
        (next: boolean) => {
            setValue(next);
            write(pref, next);
        },
        [pref]
    );

    return [value, update];
};

/**
 * A numeric preference drawn from a closed set, and a way to change it (§14b, §14g).
 *
 * Kept apart from the booleans above rather than folded into one registry: three boolean call
 * sites read perfectly and would pay for generics they do not need. The numbers are where the
 * generalisation earns its place -- there are three of them, the dwell and the tasting's two
 * lengths, and they differ only in key, choices and default.
 *
 * Stored as a plain decimal rather than the booleans' `"1"`/`"0"`. Validation is the `snap`
 * passed in, so this stays a wrapper over `localStorage` that never throws, and the part worth
 * testing lives somewhere a test can reach without a DOM.
 *
 * Read after mount, like every preference here, so the server and the client agree about the
 * first markup. The default showing for one commit costs nothing: nothing these govern is armed
 * before its picture has decoded or its video has arrived, which is always later than the
 * effect that reads storage.
 */
const useChoicePref = <T extends number>(
    key: string,
    fallback: T,
    snap: (value: string | null) => T
): [T, (value: T) => void] => {
    const [value, setValue] = useState<T>(fallback);

    useEffect(() => {
        try {
            setValue(snap(localStorage.getItem(key)));
        } catch {
            setValue(fallback);
        }
    }, [key, fallback, snap]);

    const update = useCallback(
        (next: T) => {
            setValue(next);

            try {
                localStorage.setItem(key, String(next));
            } catch {
                // As above: the setting does not persist, and the control still works for this
                // page.
            }
        },
        [key]
    );

    return [value, update];
};

/** How long a still is held in the viewer's show, in seconds (§14b). */
export const useDwellSeconds = (): [DwellSeconds, (value: DwellSeconds) => void] =>
    useChoicePref("ps:dwellSeconds", DEFAULT_DWELL, snapDwellSeconds);

const snapClip = (value: string | null): TastingSeconds =>
    snapTastingSeconds(value, DEFAULT_CLIP_SECONDS);
const snapPhoto = (value: string | null): TastingSeconds =>
    snapTastingSeconds(value, DEFAULT_PHOTO_SECONDS);

/**
 * How long the tasting plays each video, and holds each photograph (§14g).
 *
 * Their own keys rather than the viewer's dwell: a tasting's photo hold and a show's are chosen
 * in different moods, and changing one should not quietly change the other.
 */
export const useTastingClipSeconds = (): [TastingSeconds, (value: TastingSeconds) => void] =>
    useChoicePref("ps:tastingClipSeconds", DEFAULT_CLIP_SECONDS, snapClip);

export const useTastingPhotoSeconds = (): [TastingSeconds, (value: TastingSeconds) => void] =>
    useChoicePref("ps:tastingPhotoSeconds", DEFAULT_PHOTO_SECONDS, snapPhoto);

/**
 * How far the player's back and forward buttons jump (§14b). On the device like the rest: a
 * thumb on the sofa and a mouse at the desk can want different steps.
 */
export const useSkipBackSeconds = (): [SkipBackSeconds, (value: SkipBackSeconds) => void] =>
    useChoicePref("ps:skipBackSeconds", DEFAULT_SKIP_BACK, snapSkipBack);

export const useSkipForwardSeconds = (): [
    SkipForwardSeconds,
    (value: SkipForwardSeconds) => void,
] => useChoicePref("ps:skipForwardSeconds", DEFAULT_SKIP_FORWARD, snapSkipForward);
