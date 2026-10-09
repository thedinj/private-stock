import { describe, expect, it } from "vitest";

import {
    playlistSetParams,
    showcaseAddressPage,
    showcaseOriginHref,
    showcaseSet,
    showcaseSetKey,
} from "./set";

describe("a playlist as a showcase set", () => {
    it("reads back the playlist and its shuffle", () => {
        const params = playlistSetParams("p1", 42);

        expect(showcaseSet(params)).toEqual({ kind: "playlist", playlistId: "p1", seed: 42 });
    });

    it("reads back the stored order", () => {
        const params = playlistSetParams("p1", null);

        expect(showcaseSet(params)).toEqual({ kind: "playlist", playlistId: "p1", seed: null });
    });

    it("keys two orders of one playlist apart, and apart from any filter", () => {
        const stored = showcaseSetKey(showcaseSet(playlistSetParams("p1", null)));
        const shuffled = showcaseSetKey(showcaseSet(playlistSetParams("p1", 42)));
        const library = showcaseSetKey(showcaseSet(new URLSearchParams("kind=video")));

        expect(new Set([stored, shuffled, library]).size).toBe(3);
    });

    it("closes back onto the playlist, in the same order", () => {
        expect(showcaseOriginHref(playlistSetParams("p1", 42))).toBe("/playlists/p1?seed=42");
        expect(showcaseOriginHref(playlistSetParams("p1", null))).toBe(
            "/playlists/p1?order=stored"
        );
    });

    it("records the playlist's page for the viewer", () => {
        const params = playlistSetParams("p1", null);

        params.set("page", "3");

        expect(showcaseAddressPage(params)).toBe(3);
    });
});

describe("a library filter as a showcase set", () => {
    it("is keyed by its filter, as positions saved before playlists were", () => {
        const set = showcaseSet(new URLSearchParams("kind=video"));

        expect(set.kind).toBe("library");
        expect(showcaseSetKey(set)).toBe(set.kind === "library" ? set.filter : "");
    });

    it("closes back onto the library view", () => {
        expect(showcaseOriginHref(new URLSearchParams("kind=video"))).toBe("/?kind=video");
    });
});
