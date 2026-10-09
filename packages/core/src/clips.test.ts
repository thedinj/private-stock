import { describe, expect, it } from "vitest";

import {
    MAX_CLIP_SPEED,
    MIN_CLIP_MS,
    MIN_CLIP_SPEED,
    clampSpan,
    clipContains,
    effectiveRate,
    locateInReel,
    msUntilOut,
    reachedOut,
    spanRunMs,
    speedOf,
    type ClipSpan,
} from "./clips.js";

const span = (startMs: number, endMs: number, speed: number | null = null): ClipSpan => ({
    startMs,
    endMs,
    speed,
});

describe("speedOf", () => {
    it("reads NULL as one, which is the only place that rule is spelled", () => {
        expect(speedOf(null)).toBe(1);
        expect(speedOf(0.5)).toBe(0.5);
    });
});

describe("effectiveRate", () => {
    it("multiplies the clip's speed by the viewer's rather than replacing either", () => {
        expect(effectiveRate(0.5, 2)).toBe(1);
        expect(effectiveRate(2, 2)).toBe(4);
        expect(effectiveRate(0.5, 1)).toBe(0.5);
    });

    it("leaves an unset speed entirely to the viewer", () => {
        expect(effectiveRate(null, 1)).toBe(1);
        expect(effectiveRate(null, 1.75)).toBe(1.75);
    });

    it("clamps a product that leaves the range either factor was in", () => {
        // An eighth is a rate the element refuses outright, which is a span that does not play.
        expect(effectiveRate(0.5, 0.25)).toBe(MIN_CLIP_SPEED);
        expect(effectiveRate(4, 4)).toBe(MAX_CLIP_SPEED);
    });
});

describe("spanRunMs", () => {
    it("is the span's length when no speed was chosen", () => {
        expect(spanRunMs(span(1_000, 21_000))).toBe(20_000);
    });

    it("is longer than the span at half speed, which is the whole point of the column", () => {
        expect(spanRunMs(span(1_000, 21_000, 0.5))).toBe(40_000);
    });

    it("is shorter than the span at double speed", () => {
        expect(spanRunMs(span(1_000, 21_000, 2))).toBe(10_000);
    });
});

describe("msUntilOut", () => {
    it("is the remaining span at normal rate", () => {
        expect(msUntilOut(5_000, 9_000, 1)).toBe(4_000);
    });

    it("scales by the rate, because the timer is armed in wall clock", () => {
        expect(msUntilOut(5_000, 9_000, 2)).toBe(2_000);
        // The case that used to be rare and is now ordinary: a half-speed span armed as if it
        // were 1x would fire at 4000ms and cut the span in half.
        expect(msUntilOut(5_000, 9_000, 0.5)).toBe(8_000);
    });

    it("clamps at zero rather than arming a timer that never fires", () => {
        expect(msUntilOut(12_000, 9_000, 1)).toBe(0);
    });
});

describe("reachedOut", () => {
    it("tolerates the float-seconds-against-integer-milliseconds comparison", () => {
        expect(reachedOut(8_999.7, 9_000)).toBe(true);
        expect(reachedOut(8_000, 9_000)).toBe(false);
    });
});

describe("clampSpan", () => {
    it("leaves a span alone when the duration is unknown", () => {
        expect(clampSpan(span(1_000, 5_000), null)).toEqual(span(1_000, 5_000));
    });

    it("clamps rather than refuses, because the probe's duration can be short", () => {
        expect(clampSpan(span(1_000, 99_000), 10_000)).toEqual(span(1_000, 10_000));
    });

    it("returns null when nothing usable survives", () => {
        expect(clampSpan(span(50_000, 60_000), 10_000)).toBeNull();
        expect(clampSpan(span(9_950, 60_000), 10_000)).toBeNull();
    });

    it("keeps a span that is exactly the minimum length", () => {
        expect(clampSpan(span(0, MIN_CLIP_MS), 10_000)).not.toBeNull();
    });

    it("carries the speed through untouched", () => {
        expect(clampSpan(span(0, 99_000, 0.5), 10_000)?.speed).toBe(0.5);
    });
});

describe("clipContains", () => {
    it("is half open, so two abutting spans do not both claim the boundary", () => {
        expect(clipContains(span(1_000, 2_000), 1_000)).toBe(true);
        expect(clipContains(span(1_000, 2_000), 1_999)).toBe(true);
        expect(clipContains(span(1_000, 2_000), 2_000)).toBe(false);
    });
});

describe("locateInReel", () => {
    // 0-2s and 2-12s of reel: two spans cut from different files.
    const reel = [span(1_000, 3_000), span(17_000, 27_000)];

    it("finds the span a position falls in, and where inside it", () => {
        expect(locateInReel(reel, 0)).toEqual({ index: 0, atMs: 1_000 });
        expect(locateInReel(reel, 1_000)).toEqual({ index: 0, atMs: 2_000 });
        // 3s of reel is 1s into the second span.
        expect(locateInReel(reel, 3_000)).toEqual({ index: 1, atMs: 18_000 });
    });

    it("puts the boundary at the start of the next span, not the end of the last", () => {
        expect(locateInReel(reel, 2_000)).toEqual({ index: 1, atMs: 17_000 });
    });

    it("converts reel time to source time through the speed", () => {
        // A 10s span at half speed takes 20s to watch, so 10s of reel is 5s of source.
        expect(locateInReel([span(0, 10_000, 0.5)], 10_000)).toEqual({ index: 0, atMs: 5_000 });
        // And at double speed, 2s of reel is 4s of source.
        expect(locateInReel([span(0, 10_000, 2)], 2_000)).toEqual({ index: 0, atMs: 4_000 });
    });

    it("clamps past the end to the end of the last span", () => {
        expect(locateInReel(reel, 99_000)).toEqual({ index: 1, atMs: 27_000 });
    });

    it("has nothing to say about an empty reel", () => {
        expect(locateInReel([], 0)).toBeNull();
    });
});
