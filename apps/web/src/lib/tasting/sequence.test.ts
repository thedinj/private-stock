import { describe, expect, it } from "vitest";

import type { MediaListItem } from "@private-stock/core";

import { seek, tastable, type Pages, type Seek } from "./sequence";

const item = (id: string, over: Partial<MediaListItem> = {}): MediaListItem => ({
    id,
    kind: "video",
    title: id,
    durationMs: 60_000,
    width: null,
    height: null,
    addedAt: "2026-09-28T00:00:00.000Z",
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
    probed: true,
    directPlay: true,
    ...over,
});

/** A video the browser cannot play. */
const blocked = (id: string) => item(id, { directPlay: false });
const photo = (id: string) => item(id, { kind: "image" });

const pagesOf = (...pages: { items: MediaListItem[]; hasMore: boolean }[]): Pages =>
    new Map(pages.map((page, index) => [index, page]));

const none = new Set<string>();

const idOf = (result: Seek): string | null => (result.kind === "found" ? result.item.id : null);

describe("tastable", () => {
    it("takes images and playable videos, and nothing that failed", () => {
        expect(tastable(photo("a"), none)).toBe(true);
        expect(tastable(item("b"), none)).toBe(true);
        expect(tastable(blocked("c"), none)).toBe(false);
        expect(tastable(item("d"), new Set(["d"]))).toBe(false);
    });
});

describe("seek", () => {
    it("starts at the first tastable item", () => {
        const pages = pagesOf({ items: [blocked("a"), blocked("b"), photo("c")], hasMore: false });

        expect(idOf(seek({ kind: "start" }, pages, none))).toBe("c");
    });

    it("skips a run of unplayable items", () => {
        const pages = pagesOf({
            items: [item("a"), blocked("b"), blocked("c"), item("d")],
            hasMore: false,
        });
        const from = { page: 0, index: 0 };

        expect(idOf(seek({ kind: "step", from, direction: 1 }, pages, none))).toBe("d");
    });

    it("asks for the next page rather than guessing past it", () => {
        const pages = pagesOf({ items: [item("a"), blocked("b")], hasMore: true });

        expect(
            seek({ kind: "step", from: { page: 0, index: 0 }, direction: 1 }, pages, none)
        ).toEqual({
            kind: "need",
            page: 1,
        });
    });

    it("walks straight through a page with nothing playable on it", () => {
        const pages = pagesOf(
            { items: [item("a")], hasMore: true },
            { items: [blocked("b"), blocked("c")], hasMore: true }
        );

        expect(
            seek({ kind: "step", from: { page: 0, index: 0 }, direction: 1 }, pages, none)
        ).toEqual({
            kind: "need",
            page: 2,
        });
    });

    it("crosses a gap in a shuffle", () => {
        const pages = pagesOf(
            { items: [item("a")], hasMore: true },
            { items: [], hasMore: true },
            { items: [photo("c")], hasMore: false }
        );

        expect(
            idOf(seek({ kind: "step", from: { page: 0, index: 0 }, direction: 1 }, pages, none))
        ).toBe("c");
    });

    it("wraps from the last item to the first", () => {
        const pages = pagesOf(
            { items: [item("a"), item("b")], hasMore: true },
            { items: [item("c")], hasMore: false }
        );

        expect(
            idOf(seek({ kind: "step", from: { page: 1, index: 0 }, direction: 1 }, pages, none))
        ).toBe("a");
    });

    it("wraps back from the first item to the last, once the end is known", () => {
        const pages = pagesOf(
            { items: [item("a")], hasMore: true },
            { items: [blocked("b"), item("c"), blocked("d")], hasMore: false }
        );

        expect(
            idOf(seek({ kind: "step", from: { page: 0, index: 0 }, direction: -1 }, pages, none))
        ).toBe("c");
    });

    it("has nowhere to go back to before the end is known", () => {
        const pages = pagesOf({ items: [item("a")], hasMore: true });

        expect(
            seek({ kind: "step", from: { page: 0, index: 0 }, direction: -1 }, pages, none)
        ).toEqual({
            kind: "none",
        });
    });

    it("ends a whole lap with nothing tastable instead of circling", () => {
        const pages = pagesOf({ items: [blocked("a"), blocked("b")], hasMore: false });

        expect(seek({ kind: "start" }, pages, none)).toEqual({ kind: "none" });
        expect(
            seek({ kind: "step", from: { page: 0, index: 1 }, direction: 1 }, pages, none)
        ).toEqual({
            kind: "none",
        });
    });

    it("comes round to a lone playable item again", () => {
        const pages = pagesOf({ items: [blocked("a"), item("b"), blocked("c")], hasMore: false });

        expect(
            idOf(seek({ kind: "step", from: { page: 0, index: 1 }, direction: 1 }, pages, none))
        ).toBe("b");
        expect(
            idOf(seek({ kind: "step", from: { page: 0, index: 1 }, direction: -1 }, pages, none))
        ).toBe("b");
    });

    it("stops when every loaded page is empty", () => {
        const pages = pagesOf({ items: [], hasMore: true }, { items: [], hasMore: false });

        expect(seek({ kind: "start" }, pages, none)).toEqual({ kind: "none" });
    });

    it("reports an empty set", () => {
        expect(seek({ kind: "start" }, pagesOf({ items: [], hasMore: false }), none)).toEqual({
            kind: "none",
        });
    });

    it("moves on from an item that failed", () => {
        const pages = pagesOf({ items: [item("a"), item("b")], hasMore: false });

        expect(idOf(seek({ kind: "start" }, pages, new Set(["a"])))).toBe("b");
    });

    describe("anchored on a return from the viewer", () => {
        const pages: Pages = new Map([
            [0, { items: [item("a")], hasMore: true }],
            [1, { items: [item("b"), blocked("c"), item("d")], hasMore: false }],
        ]);

        it("lands on the item", () => {
            expect(idOf(seek({ kind: "anchor", page: 1, itemId: "b" }, pages, none))).toBe("b");
        });

        it("lands on the next tastable item when that one cannot be tasted", () => {
            expect(idOf(seek({ kind: "anchor", page: 1, itemId: "c" }, pages, none))).toBe("d");
        });

        it("starts the page when the item is gone", () => {
            expect(idOf(seek({ kind: "anchor", page: 1, itemId: "zz" }, pages, none))).toBe("b");
        });

        it("waits for its page", () => {
            expect(seek({ kind: "anchor", page: 4, itemId: "b" }, pages, none)).toEqual({
                kind: "need",
                page: 4,
            });
        });
    });
});
