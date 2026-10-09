"use client";

import { useCallback, useEffect, useState } from "react";

import type { PlaylistView } from "./playlistView";

type Layout = PlaylistView["mode"];

const KEY = "ps:playlistLayout";

/**
 * Grid or gallery for playlists, remembered on this device (§14b).
 *
 * A playlist opened from the sidebar or Collections arrives at its plain address, and the
 * layout is the one part of how it was last seen that should come back: a list you browse as a
 * gallery is a list you browse as a gallery. Its page and order should not -- a list that likes
 * a fresh shuffle gets one each time it is opened. One preference for every playlist rather
 * than one each, because it is a habit of the viewer's and not a property of the list.
 *
 * Read after mount, like every preference here, so the server and the client agree about the
 * first markup.
 */
export const usePlaylistLayout = (): [Layout, (layout: Layout) => void] => {
    const [layout, setLayout] = useState<Layout>("grid");

    useEffect(() => {
        try {
            setLayout(localStorage.getItem(KEY) === "gallery" ? "gallery" : "grid");
        } catch {
            // Private window or storage off: the default it already holds.
        }
    }, []);

    const remember = useCallback((next: Layout) => {
        setLayout(next);

        try {
            localStorage.setItem(KEY, next);
        } catch {
            // Not remembered; the toggle still works for this page.
        }
    }, []);

    return [layout, remember];
};
