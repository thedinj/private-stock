import { beforeEach, describe, expect, it } from "vitest";

import type { MediaListItem } from "@private-stock/core";

import {
    readShelf,
    rememberReturnTo,
    rememberShelf,
    requestReturnCorrection,
    returnAtPage,
    returnLabel,
    takeReturnCorrection,
} from "./returnTo";

/** The unit suite runs in Node, which has no `sessionStorage`. */
const storage = new Map<string, string>();

globalThis.sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
} as Storage;

beforeEach(() => storage.clear());

/** Only the opener's address is read from `window`, and only by `rememberShelf`. */
const openFrom = (pathname: string, search = ""): void => {
    globalThis.window = { location: { pathname, search } } as Window & typeof globalThis;
};

const item = (id: string): MediaListItem => ({
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
});

describe("rememberShelf", () => {
    it("records the shelf with the address it was opened from", () => {
        openFrom("/");
        rememberShelf([item("a"), item("b")]);

        expect(readShelf("/")?.map((entry) => entry.id)).toEqual(["a", "b"]);
    });

    it("is not read against a different address", () => {
        openFrom("/");
        rememberShelf([item("a")]);

        expect(readShelf("/?view=grid")).toBeNull();
    });

    it("is cleared by any later opening, so a snapshot only ever describes its own", () => {
        openFrom("/");
        rememberShelf([item("a")]);
        rememberReturnTo("/");

        expect(readShelf("/")).toBeNull();
    });

    it("reads nothing from a snapshot that no longer parses", () => {
        storage.set("ps:returnShelf", JSON.stringify({ href: "/", items: [{ id: "a" }] }));

        expect(readShelf("/")).toBeNull();
    });
});

describe("returnAtPage", () => {
    it("moves an address to another page, keeping everything else", () => {
        expect(returnAtPage("/?view=grid&tags=a%2Cb&page=2", 3)).toBe(
            "/?view=grid&tags=a%2Cb&page=3"
        );
        expect(returnAtPage("/showcase?view=grid", 1)).toBe("/showcase?view=grid&page=1");
    });

    it("writes the first page as no page, the way the library does", () => {
        expect(returnAtPage("/?view=grid&page=1", 0)).toBe("/?view=grid");
        expect(returnAtPage("/playlists/p?page=1", 0)).toBe("/playlists/p");
    });
});

describe("returnLabel", () => {
    it("names the place by its path before its query", () => {
        expect(returnLabel("/showcase?view=grid")).toBe("the showcase");
        expect(returnLabel("/tasting?view=grid&page=3")).toBe("the tasting");
        expect(returnLabel("/playlists/p?page=2")).toBe("the playlist");
        expect(returnLabel("/review/duplicates?page=1")).toBe("duplicates");
        expect(returnLabel("/captures?sort=title&page=2")).toBe("captures");
        expect(returnLabel("/tags/performers?q=ann&seed=4")).toBe("performers");
        expect(returnLabel("/?view=grid&page=2")).toBe("library");
        expect(returnLabel("/")).toBe("Home");
    });
});

describe("return correction", () => {
    it("hands the receiving page the address the viewer reached", () => {
        requestReturnCorrection("/?view=grid&page=4");

        expect(takeReturnCorrection("/?view=grid&page=2")).toBe("/?view=grid&page=4");
    });

    it("is consumed, so it cannot be applied twice", () => {
        requestReturnCorrection("/?view=grid&page=4");
        takeReturnCorrection("/?view=grid&page=2");

        expect(takeReturnCorrection("/?view=grid&page=2")).toBeNull();
    });

    it("applies only to the same path, and only when it changes something", () => {
        requestReturnCorrection("/?view=grid&page=4");
        expect(takeReturnCorrection("/playlists/p")).toBeNull();

        requestReturnCorrection("/?view=grid&page=4");
        expect(takeReturnCorrection("/?view=grid&page=4")).toBeNull();
    });
});
