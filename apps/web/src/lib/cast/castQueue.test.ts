import { describe, expect, it } from "vitest";

import { castSync, idsToQueue, playedThrough, QUEUE_LOW_WATER } from "./castQueue";

describe("castSync", () => {
    it("loads the page's item at the start of a session", () => {
        expect(castSync("a", null, null)).toEqual({ kind: "load" });
    });

    it("sends the TV to the page when the page moved", () => {
        expect(castSync("b", "a", "a")).toEqual({ kind: "load" });
    });

    it("follows the TV when its queue moved on", () => {
        expect(castSync("a", "b", "a")).toEqual({ kind: "follow", mediaId: "b" });
    });

    it("follows the TV when both moved, since the TV is what is on screen", () => {
        expect(castSync("c", "b", "a")).toEqual({ kind: "follow", mediaId: "b" });
    });

    it("joins a TV already playing something when the session is picked up", () => {
        expect(castSync("a", "x", null)).toEqual({ kind: "follow", mediaId: "x" });
    });

    it("does nothing in step", () => {
        expect(castSync("a", "a", "a")).toEqual({ kind: "none" });
    });

    /** The end of the show, not a reason to play the last item again. */
    it("does not restart an item whose queue ran out", () => {
        expect(castSync("a", null, "a")).toEqual({ kind: "none" });
    });
});

describe("idsToQueue", () => {
    const none = new Set<string>();

    it("tops up when fewer than the low-water mark remain", () => {
        expect(idsToQueue(["b", "c", "d"], ["a", "b"], "a", none)).toEqual(["c", "d"]);
    });

    it("adds nothing while the queue has enough ahead", () => {
        const queued = ["a", ...Array.from({ length: QUEUE_LOW_WATER }, (_, i) => `q${i}`)];

        expect(idsToQueue(["z"], queued, "a", none)).toEqual([]);
    });

    it("skips what the server already refused", () => {
        expect(idsToQueue(["b", "c"], ["a"], "a", new Set(["b"]))).toEqual(["c"]);
    });

    it("treats a current item missing from the queue as nothing ahead", () => {
        expect(idsToQueue(["b"], ["x", "y", "z", "w"], "a", none)).toEqual(["b"]);
    });
});

describe("playedThrough", () => {
    const queue = ["a", "b", "c", "d"];

    it("counts the item the TV moved on from", () => {
        expect(playedThrough(queue, "a", "b")).toEqual(["a"]);
    });

    /** The phone slept through two items; they still count when it wakes. */
    it("counts everything passed while nobody was looking", () => {
        expect(playedThrough(queue, "a", "d")).toEqual(["a", "b", "c"]);
    });

    it("counts nothing for a TV playing something it was not sent from here", () => {
        expect(playedThrough(queue, "a", "x")).toEqual([]);
        expect(playedThrough(queue, null, "b")).toEqual([]);
    });

    it("counts nothing when the TV went back rather than on", () => {
        expect(playedThrough(queue, "c", "b")).toEqual([]);
    });
});
