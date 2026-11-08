import { describe, expect, it } from "vitest";

import { pickSegment, segmentAt, segmentProgress, pickRoomSegment } from "./segment";

const at = (value: number) => () => value;

describe("pickSegment", () => {
    it("starts at the beginning when the length is not known", () => {
        for (const duration of [null, 0, -5, Number.NaN, Infinity]) {
            expect(pickSegment(duration, 10_000, at(0.5))).toEqual({ startMs: 0, endMs: 10_000 });
        }
    });

    it("plays the whole of anything no longer than a taste", () => {
        expect(pickSegment(4_000, 10_000, at(0.5))).toEqual({ startMs: 0, endMs: 4_000 });
        expect(pickSegment(10_000, 10_000, at(0.5))).toEqual({ startMs: 0, endMs: 10_000 });
    });

    it("starts at the trimmed start when the window is too narrow for a whole taste", () => {
        // 12s file, 11s taste: the window 0.6s–(11.4s - 11s) is inverted.
        expect(pickSegment(12_000, 11_000, at(0.9))).toEqual({ startMs: 600, endMs: 11_600 });
    });

    it("stays inside the middle nine tenths, at exactly the clip length", () => {
        const duration = 600_000;

        for (const random of [0, 0.25, 0.5, 0.999999]) {
            const segment = pickSegment(duration, 10_000, at(random));

            expect(segment.startMs).toBeGreaterThanOrEqual(duration * 0.05);
            expect(segment.endMs).toBeLessThanOrEqual(duration * 0.95 + 1);
            expect(segment.endMs - segment.startMs).toBe(10_000);
            expect(Number.isInteger(segment.startMs)).toBe(true);
        }
    });

    it("spans the window from one end to the other", () => {
        expect(pickSegment(100_000, 10_000, at(0)).startMs).toBe(5_000);
        expect(pickSegment(100_000, 10_000, at(1)).startMs).toBe(85_000);
    });
});

describe("segmentProgress", () => {
    const segment = { startMs: 1_000, endMs: 3_000 };

    it("measures from the in point to the out point, clamped", () => {
        expect(segmentProgress(0, segment)).toBe(0);
        expect(segmentProgress(2_000, segment)).toBe(0.5);
        expect(segmentProgress(9_000, segment)).toBe(1);
    });

    it("calls an empty segment finished", () => {
        expect(segmentProgress(0, { startMs: 5, endMs: 5 })).toBe(1);
    });
});

describe("a look's segment", () => {
    it("starts a second before the match", () => {
        expect(segmentAt(600_000, 20_000, 90_000)).toEqual({ startMs: 89_000, endMs: 109_000 });
    });

    it("pulls back to fit a whole taste before the end", () => {
        expect(segmentAt(100_000, 20_000, 95_000)).toEqual({ startMs: 80_000, endMs: 100_000 });
    });

    it("never starts before the beginning", () => {
        expect(segmentAt(100_000, 20_000, 400)).toEqual({ startMs: 0, endMs: 20_000 });
    });

    it("plays the whole of anything shorter than a taste", () => {
        expect(segmentAt(8_000, 20_000, 5_000)).toEqual({ startMs: 0, endMs: 8_000 });
    });

    it("trusts the match when the length is not known", () => {
        expect(segmentAt(null, 20_000, 30_000)).toEqual({ startMs: 29_000, endMs: 49_000 });
    });
});

describe("pickRoomSegment (§21)", () => {
    it("draws a Game Room taste from the last ten seconds, ending inside the file", () => {
        expect(pickRoomSegment(30_000, 6_000, 10_000, () => 0)).toEqual({
            startMs: 20_000,
            endMs: 26_000,
        });
        expect(pickRoomSegment(30_000, 6_000, 10_000, () => 1)).toEqual({
            startMs: 24_000,
            endMs: 30_000,
        });
    });

    it("ends at the end when a taste is longer than the tail, and plays a short item whole", () => {
        expect(pickRoomSegment(30_000, 12_000, 10_000, () => 0.5)).toEqual({
            startMs: 18_000,
            endMs: 30_000,
        });
        expect(pickRoomSegment(5_000, 6_000, 10_000)).toEqual({ startMs: 0, endMs: 5_000 });
    });

    it("is the ordinary pick in a room with no tail, or before the length is known", () => {
        expect(pickRoomSegment(100_000, 6_000, null, () => 0)).toEqual(
            pickSegment(100_000, 6_000, () => 0)
        );
        expect(pickRoomSegment(null, 6_000, 10_000)).toEqual({ startMs: 0, endMs: 6_000 });
    });
});
