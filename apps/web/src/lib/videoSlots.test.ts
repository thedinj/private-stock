import { describe, expect, it } from "vitest";

import { advanceTo, assignSlots, initialSlots, type SlotState } from "./videoSlots";

/**
 * The two-element swap (§8b).
 *
 * Every test here is really the same assertion: **the element holding the item you are about
 * to watch must not move and must not be rebuilt.** That is what the whole preload rests on,
 * and it is invisible when it breaks — a version that threw the warmed element away would
 * still play everything, just always from a cold start.
 */

const walk = (start: SlotState, steps: [string, string | null][]): SlotState =>
    steps.reduce((state, [playing, warming]) => assignSlots(state, playing, warming), start);

describe("opening the first item", () => {
    it("puts it in the first slot and plays it", () => {
        expect(initialSlots("a")).toEqual({ ids: ["a", null], active: 0 });
    });

    it("warms the next one in the slot that is not on screen", () => {
        expect(assignSlots(initialSlots("a"), "a", "b")).toEqual({
            ids: ["a", "b"],
            active: 0,
        });
    });
});

describe("stepping onto something already warmed", () => {
    /** The point of all of it: the index moves, the slot's contents do not. */
    it("moves the active index rather than the item", () => {
        const state = walk(initialSlots("a"), [
            ["a", "b"],
            ["b", "c"],
        ]);

        expect(state.active).toBe(1);
        expect(state.ids[1]).toBe("b");
    });

    it("warms the one after it in the slot just vacated", () => {
        const state = walk(initialSlots("a"), [
            ["a", "b"],
            ["b", "c"],
        ]);

        expect(state.ids[0]).toBe("c");
    });

    /** Three steps: the active index alternates and nothing ever has to be moved. */
    it("alternates as you keep going", () => {
        const state = walk(initialSlots("a"), [
            ["a", "b"],
            ["b", "c"],
            ["c", "d"],
        ]);

        expect(state).toEqual({ ids: ["c", "d"], active: 0 });
    });

    /** Backwards through a set is the same gesture, and the same arithmetic serves it. */
    it("works when the warmed item is the previous one", () => {
        const state = walk(initialSlots("b"), [
            ["b", "a"],
            ["a", null],
        ]);

        expect(state.active).toBe(1);
        expect(state.ids[1]).toBe("a");
    });
});

describe("stepping onto something nobody warmed", () => {
    /**
     * A jump from the grid, a shared link, or a set whose next item cannot be direct-played.
     * The element on screen is reused for it, which is what the player did before any of this
     * existed — the cost is the old cost, not a new one.
     */
    it("overwrites the element on screen and stays there", () => {
        const state = walk(initialSlots("a"), [
            ["a", "b"],
            ["z", null],
        ]);

        expect(state).toEqual({ ids: ["z", null], active: 0 });
    });

    it("drops the item that was warming, since it is no longer next", () => {
        const state = walk(initialSlots("a"), [
            ["a", "b"],
            ["z", "y"],
        ]);

        expect(state.ids).toEqual(["z", "y"]);
    });
});

describe("what it refuses to do", () => {
    it("never holds the playing item in both slots", () => {
        expect(assignSlots(initialSlots("a"), "a", "a")).toEqual({ ids: ["a", null], active: 0 });
    });

    it("empties the idle slot at the end of a set", () => {
        const state = walk(initialSlots("a"), [
            ["a", "b"],
            ["b", null],
        ]);

        expect(state.ids[0]).toBeNull();
        expect(state.ids[1]).toBe("b");
    });

    /**
     * Called during render, so identity is the difference between two elements and two
     * hundred. Everything below returns the same object, and React sees no change at all.
     */
    it("returns the very same state when nothing moves", () => {
        const settled = assignSlots(initialSlots("a"), "a", "b");

        expect(assignSlots(settled, "a", "b")).toBe(settled);
    });

    it("returns the same state on a repeated step", () => {
        const stepped = walk(initialSlots("a"), [
            ["a", "b"],
            ["b", "c"],
        ]);

        expect(assignSlots(stepped, "b", "c")).toBe(stepped);
    });
});

describe("advanceTo", () => {
    it("seeks when the next span is in the file already on screen", () => {
        // A reel with two spans of one afternoon's video. Opening the file twice is the thing
        // §8b's warming gate exists to prevent, arriving from a new direction.
        const state = assignSlots(initialSlots("A"), "A", null);

        expect(advanceTo(state, "A")).toEqual({ kind: "seek", index: 0 });
    });

    it("swaps to the element that was warmed", () => {
        const state = assignSlots(initialSlots("A"), "A", "B");

        expect(advanceTo(state, "B")).toEqual({ kind: "swap", index: 1 });
    });

    it("starts cold for a file neither element holds", () => {
        const state = assignSlots(initialSlots("A"), "A", "B");

        expect(advanceTo(state, "C")).toEqual({ kind: "cold", index: 0 });
    });

    it("keeps the element when a reel returns to a file it already has open", () => {
        /**
         * A, B, A. Keyed by media id, slot 0 still holds A while B is playing, so coming back
         * to A is a swap onto an element that never lost its buffer — and the player seeks it to
         * the new span's in-point on arrival.
         *
         * Keyed by the reel's own positions this would be a `cold`: slot 0 would hold "position
         * 0", the reel would want "position 2", and React would rebuild the element and download
         * file A again for a file that never changed. That is the whole argument for the key.
         */
        let state = assignSlots(initialSlots("A"), "A", "B");

        state = assignSlots(state, "B", "A");

        expect(state.ids).toEqual(["A", "B"]);
        expect(state.active).toBe(1);
        expect(advanceTo(state, "A")).toEqual({ kind: "swap", index: 0 });
    });
});
