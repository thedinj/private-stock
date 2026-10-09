import { describe, expect, it } from "vitest";

import {
    DEFAULT_PLAYLIST_VIEW,
    parsePlaylistView,
    playlistHref,
    playlistIdFromPath,
    playlistViewToParams,
    resolvePlaylistView,
} from "./playlistView";

const parse = (query: string) => parsePlaylistView(new URLSearchParams(query));

describe("parsePlaylistView", () => {
    it("treats a bare address as undecided", () => {
        const view = parse("");

        expect(view.decided).toBe(false);
        expect(view.seed).toBeNull();
    });

    it("reads a seed as a decision to shuffle", () => {
        expect(parse("seed=42")).toMatchObject({ seed: 42, decided: true });
    });

    it("reads order=stored as a decision not to", () => {
        expect(parse("order=stored")).toMatchObject({ seed: null, decided: true });
    });

    it("lets the explicit word beat a leftover seed", () => {
        // Hand-edited or half-updated addresses happen. A list somebody asked to see in
        // order must not quietly shuffle because an old seed survived in the query.
        expect(parse("order=stored&seed=9")).toMatchObject({ seed: null, decided: true });
    });
});

describe("playlistViewToParams", () => {
    it("says which order it means, both ways round", () => {
        expect(
            playlistViewToParams({ ...DEFAULT_PLAYLIST_VIEW, seed: 7, decided: true }).get("seed")
        ).toBe("7");
        expect(
            playlistViewToParams({ ...DEFAULT_PLAYLIST_VIEW, seed: null, decided: true }).get(
                "order"
            )
        ).toBe("stored");
    });

    it("omits everything an undecided first visit does not need", () => {
        expect(playlistViewToParams(DEFAULT_PLAYLIST_VIEW).toString()).toBe("");
    });

    it("round-trips through an address", () => {
        const view = { page: 3, seed: 11, decided: true, mode: "gallery" as const };
        const href = playlistHref("abc", view);

        expect(href.startsWith("/playlists/abc?")).toBe(true);
        expect(parsePlaylistView(new URLSearchParams(href.slice(href.indexOf("?"))))).toEqual(view);
    });
});

describe("playlistIdFromPath", () => {
    it("recognises a playlist address, with or without a query", () => {
        expect(playlistIdFromPath("/playlists/abc")).toBe("abc");
        expect(playlistIdFromPath("/playlists/abc?page=2&seed=1")).toBe("abc");
    });

    it("is not fooled by the library or by the index", () => {
        expect(playlistIdFromPath("/?view=grid")).toBeNull();
        expect(playlistIdFromPath("/playlists")).toBeNull();
        expect(playlistIdFromPath("/playlists/abc/extra")).toBeNull();
    });
});

describe("resolvePlaylistView", () => {
    it("uses the list's default only while the address is undecided", () => {
        expect(resolvePlaylistView(DEFAULT_PLAYLIST_VIEW, "shuffle", 5)).toMatchObject({
            seed: 5,
            decided: true,
        });
        expect(resolvePlaylistView(DEFAULT_PLAYLIST_VIEW, null, 5)).toMatchObject({
            seed: null,
            decided: true,
        });
    });

    it("leaves a decided address alone, whichever way the default points", () => {
        // This is what stops the toggle fighting the default: switching shuffle off writes
        // `order=stored`, and a list that prefers shuffle must not switch it back on.
        const stored = { ...DEFAULT_PLAYLIST_VIEW, decided: true };

        expect(resolvePlaylistView(stored, "shuffle", 5)).toEqual(stored);
    });
});
