import { describe, expect, it } from "vitest";

import {
    COVER_CLEARED_CHANGE,
    type HomeResponse,
    type MediaListItem,
    type MediaListResponse,
} from "@private-stock/core";

import {
    artifactPatch,
    patchItems,
    patchListPage,
    patchShelves,
    refreshListPage,
} from "./patchList";

/**
 * Patching a finished cover into what is on screen (§13b).
 *
 * The bug these guard against was not a wrong patch but a patch against a **shape that does not
 * exist**: the updater read `data.pages`, which belongs to an infinite query, and this app has
 * none. So the tests below are mostly about shape — they build the caches the way the app
 * actually caches them and would fail the moment either one is patched as something else.
 */

const item = (id: string, over: Partial<MediaListItem> = {}): MediaListItem => ({
    id,
    kind: "video",
    title: id,
    durationMs: null,
    width: null,
    height: null,
    addedAt: "2026-09-24T00:00:00.000Z",
    capturedAt: null,
    sizeBytes: null,
    coverUrl: null,
    previewUrl: null,
    rating: null,
    favorite: false,
    watchedAt: null,
    tags: [],
    tagCount: 0,
    performers: [],
    performerCount: 0,
    probed: false,
    directPlay: true,
    ...over,
});

const page = (...items: MediaListItem[]): MediaListResponse => ({
    items,
    page: 0,
    pageSize: 60,
    hasMore: false,
    total: null,
});

const home = (...items: MediaListItem[]): HomeResponse => ({
    shelves: [
        {
            key: "recent",
            title: "Recently added",
            shelf: { source: "builtin", builtin: "recentlyAdded", limit: 12 },
            items,
            unavailable: null,
        },
    ],
    isDefault: true,
});

describe("one item in a list", () => {
    it("takes the cover", () => {
        const patched = patchItems([item("a"), item("b")], "b", { coverUrl: "/cover-b" });

        expect(patched[1]?.coverUrl).toBe("/cover-b");
    });

    it("leaves everything else alone", () => {
        const patched = patchItems([item("a"), item("b")], "b", { coverUrl: "/cover-b" });

        expect(patched[0]?.coverUrl).toBeNull();
        expect(patched[1]?.title).toBe("b");
    });

    /**
     * Identity is the point, not an optimisation: there is one of these calls per cached page,
     * and a new array from each would re-render the whole grid for an item it is not showing.
     */
    it("returns the same array when the item is not in it", () => {
        const items = [item("a")];

        expect(patchItems(items, "z", { coverUrl: "/cover-z" })).toBe(items);
    });
});

describe("a page of the grid", () => {
    it("patches the item inside it", () => {
        const patched = patchListPage(page(item("a")), "a", { coverUrl: "/cover-a" });

        expect(patched?.items[0]?.coverUrl).toBe("/cover-a");
    });

    it("keeps the paging alongside the items", () => {
        const patched = patchListPage(page(item("a")), "a", { coverUrl: "/cover-a" });

        expect(patched?.pageSize).toBe(60);
        expect(patched?.hasMore).toBe(false);
    });

    it("returns the same page when the item is elsewhere", () => {
        const cached = page(item("a"));

        expect(patchListPage(cached, "z", { coverUrl: "/cover-z" })).toBe(cached);
    });

    /** A cache entry that has not been fetched yet is a real state, not a bug to throw on. */
    it("survives an empty cache", () => {
        expect(patchListPage(undefined, "a", { coverUrl: "/cover-a" })).toBeUndefined();
    });
});

describe("re-checking the items on a page", () => {
    it("updates items in place and keeps their order", () => {
        const before = page(item("a"), item("b", { title: "processing…" }), item("c"));
        const fresh = [item("c"), item("b", { title: "Probed" }), item("a")];

        const after = refreshListPage(before, fresh);

        expect(after?.items.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
        expect(after?.items[1]?.title).toBe("Probed");
    });

    it("drops an item the server no longer returns, and adds nothing", () => {
        const after = refreshListPage(page(item("a"), item("b"), item("c")), [
            item("a"),
            item("c"),
            item("new"),
        ]);

        expect(after?.items.map((entry) => entry.id)).toEqual(["a", "c"]);
    });
});

describe("the room's shelves", () => {
    it("patches an item inside a shelf", () => {
        const patched = patchShelves(home(item("a")), "a", { coverUrl: "/cover-a" });

        expect(patched?.shelves[0]?.items[0]?.coverUrl).toBe("/cover-a");
    });

    it("returns the same response when no shelf holds the item", () => {
        const cached = home(item("a"));

        expect(patchShelves(cached, "z", { coverUrl: "/cover-z" })).toBe(cached);
    });

    it("survives an empty cache", () => {
        expect(patchShelves(undefined, "a", { coverUrl: "/cover-a" })).toBeUndefined();
    });
});

describe("what a preview patches", () => {
    /**
     * Kind by kind, because they are not interchangeable: an item can have a preview before it
     * has a cover, and writing a cover URL on the strength of a preview being ready points a
     * tile at a file that is not there yet — a broken image in place of "processing…".
     */
    it("leaves the cover alone", () => {
        const patched = patchItems([item("a")], "a", { previewUrl: "/preview-a" });

        expect(patched[0]?.previewUrl).toBe("/preview-a");
        expect(patched[0]?.coverUrl).toBeNull();
    });
});

describe("what each artifact event patches", () => {
    it("points a new cover at the alias, with the change id as its version", () => {
        expect(artifactPatch("a", "cover", 42)).toEqual({ coverUrl: "/api/art/a/cover?v=42" });
    });

    it("points a new preview at the preview, and never at the cover", () => {
        expect(artifactPatch("a", "preview", 42)).toEqual({
            previewUrl: "/api/art/a/preview?v=42",
        });
    });

    /**
     * Discarding the capture that was the cover of an item with no generated cover (§9). The
     * alias would answer 404, so the tile goes back to its placeholder instead of breaking.
     */
    it("clears the cover when there is none left, rather than pointing at nothing", () => {
        const patch = artifactPatch("a", COVER_CLEARED_CHANGE, 42);

        expect(patch).toEqual({ coverUrl: null });
        expect(patchItems([item("a", { coverUrl: "/old" })], "a", patch!)[0]?.coverUrl).toBeNull();
    });

    it("patches nothing for an artifact no list draws", () => {
        expect(artifactPatch("a", "spriteVtt", 42)).toBeNull();
        expect(artifactPatch("a", null, 42)).toBeNull();
    });
});
