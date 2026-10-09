import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    PREVIEW_PRIORITY_GALLERY,
    PREVIEW_PRIORITY_HOVER,
    PREVIEW_PRIORITY_VOICE,
    activePreviewCount,
    releasePreviewSlot,
    requestPreviewSlot,
    resetPreviewBudget,
} from "./previewBudget";

/**
 * Gallery mode puts forty tiles on screen that all want to play video, and browsers do not
 * allow that — each `<video>` holds a hardware decoder and mobile browsers cap the count
 * sharply. Exceeding the cap does not queue: playback silently fails or stalls the streams
 * already running, which looks like a broken app rather than a busy one.
 *
 * So the invariant these tests exist for is simply: never more than the limit, and the tile
 * the user is actually pointing at always wins.
 */
beforeEach(() => {
    resetPreviewBudget(3);
});

const tile = (name: string) => ({ name });

describe("requestPreviewSlot", () => {
    it("grants up to the limit and never beyond it", () => {
        const granted: string[] = [];

        for (const name of ["a", "b", "c", "d", "e"]) {
            requestPreviewSlot(tile(name), PREVIEW_PRIORITY_GALLERY, (ok) => {
                if (ok) granted.push(name);
            });
        }

        expect(granted).toEqual(["a", "b", "c"]);
        expect(activePreviewCount()).toBe(3);
    });

    it("is idempotent, so a re-render does not consume a second slot", () => {
        const token = tile("a");

        requestPreviewSlot(token, PREVIEW_PRIORITY_GALLERY, vi.fn());
        requestPreviewSlot(token, PREVIEW_PRIORITY_GALLERY, vi.fn());

        expect(activePreviewCount()).toBe(1);
    });

    it("lets a hovered tile displace an autoplaying one", () => {
        const listeners = new Map<string, ReturnType<typeof vi.fn>>();

        for (const name of ["a", "b", "c"]) {
            const listener = vi.fn();
            listeners.set(name, listener);
            requestPreviewSlot(tile(name), PREVIEW_PRIORITY_GALLERY, listener);
        }

        const hovered = vi.fn();
        requestPreviewSlot(tile("hover"), PREVIEW_PRIORITY_HOVER, hovered);

        expect(hovered).toHaveBeenCalledWith(true);
        // The oldest gallery tile gave way, and was told so rather than being left thinking
        // it is still playing.
        expect(listeners.get("a")).toHaveBeenLastCalledWith(false);
        expect(activePreviewCount()).toBe(3);
    });

    it("lets the showcase's voice displace the oldest silent preview, hovered or not", () => {
        const gallery = vi.fn();
        const hovered = vi.fn();

        requestPreviewSlot(tile("gallery"), PREVIEW_PRIORITY_GALLERY, gallery);
        requestPreviewSlot(tile("h1"), PREVIEW_PRIORITY_HOVER, hovered);
        requestPreviewSlot(tile("h2"), PREVIEW_PRIORITY_HOVER, vi.fn());

        const live = vi.fn();
        const cued = vi.fn();

        requestPreviewSlot(tile("live"), PREVIEW_PRIORITY_VOICE, live);
        requestPreviewSlot(tile("cued"), PREVIEW_PRIORITY_VOICE, cued);

        expect(live).toHaveBeenCalledWith(true);
        expect(cued).toHaveBeenCalledWith(true);
        // The autoplaying tile goes first; only then a hovered one.
        expect(gallery).toHaveBeenLastCalledWith(false);
        expect(hovered).toHaveBeenLastCalledWith(false);
        expect(activePreviewCount()).toBe(3);
    });

    it("makes a hovered tile wait rather than displacing another hovered tile", () => {
        for (const name of ["a", "b", "c"]) {
            requestPreviewSlot(tile(name), PREVIEW_PRIORITY_HOVER, vi.fn());
        }

        const latecomer = vi.fn();
        requestPreviewSlot(tile("d"), PREVIEW_PRIORITY_HOVER, latecomer);

        expect(latecomer).not.toHaveBeenCalled();
        expect(activePreviewCount()).toBe(3);
    });

    it("evicts the earliest holder, not an arbitrary one", () => {
        const calls: string[] = [];

        for (const name of ["first", "second", "third"]) {
            requestPreviewSlot(tile(name), PREVIEW_PRIORITY_GALLERY, (ok) => {
                if (!ok) calls.push(name);
            });
        }

        requestPreviewSlot(tile("new"), PREVIEW_PRIORITY_HOVER, vi.fn());

        expect(calls).toEqual(["first"]);
    });
});

describe("releasePreviewSlot", () => {
    it("hands the freed slot to a waiter", () => {
        const tokens = ["a", "b", "c"].map(tile);
        tokens.forEach((token) => requestPreviewSlot(token, PREVIEW_PRIORITY_GALLERY, vi.fn()));

        const waiter = vi.fn();
        requestPreviewSlot(tile("d"), PREVIEW_PRIORITY_GALLERY, waiter);
        expect(waiter).not.toHaveBeenCalled();

        releasePreviewSlot(tokens[0]);

        expect(waiter).toHaveBeenCalledWith(true);
        expect(activePreviewCount()).toBe(3);
    });

    it("prefers a hovered waiter over a gallery waiter", () => {
        const tokens = ["a", "b", "c"].map(tile);
        tokens.forEach((token) => requestPreviewSlot(token, PREVIEW_PRIORITY_HOVER, vi.fn()));

        const gallery = vi.fn();
        const hover = vi.fn();
        requestPreviewSlot(tile("gallery"), PREVIEW_PRIORITY_GALLERY, gallery);
        requestPreviewSlot(tile("hover"), PREVIEW_PRIORITY_HOVER, hover);

        releasePreviewSlot(tokens[0]);

        expect(hover).toHaveBeenCalledWith(true);
        expect(gallery).not.toHaveBeenCalled();
    });

    it("drops a waiter that leaves before its turn", () => {
        const tokens = ["a", "b", "c"].map(tile);
        tokens.forEach((token) => requestPreviewSlot(token, PREVIEW_PRIORITY_GALLERY, vi.fn()));

        const scrolledAway = tile("d");
        const listener = vi.fn();
        requestPreviewSlot(scrolledAway, PREVIEW_PRIORITY_GALLERY, listener);

        // Scrolled out of view while queued. Without this it would be granted a slot later
        // and start decoding video for a tile nobody can see.
        releasePreviewSlot(scrolledAway);
        releasePreviewSlot(tokens[0]);

        expect(listener).not.toHaveBeenCalled();
        expect(activePreviewCount()).toBe(2);
    });

    it("tolerates releasing something that never held a slot", () => {
        expect(() => releasePreviewSlot(tile("ghost"))).not.toThrow();
    });
});
