import { describe, expect, it } from "vitest";

import { parseRange, RANGE_WINDOW_BYTES } from "./byteRange";

/**
 * Range handling for the direct-play path (§8, §8b).
 *
 * The window is the reason these exist. Everything else here was working and is pinned so a
 * later change to the bound cannot quietly break the shapes a player actually sends: open from
 * zero, open from a seek, a suffix for the index, and an explicit window of its own choosing.
 */

const SIZE = 565_281_046;

describe("parseRange", () => {
    it("treats a missing or unparseable header as no range", () => {
        expect(parseRange(null, SIZE)).toBeNull();
        expect(parseRange("bytes=", SIZE)).toBeNull();
        expect(parseRange("items=0-1", SIZE)).toBeNull();
        // Multi-range: answered with the whole file rather than multipart.
        expect(parseRange("bytes=0-99, 200-299", SIZE)).toBeNull();
    });

    it("caps an open-ended range at the window", () => {
        expect(parseRange("bytes=0-", SIZE)).toEqual({
            start: 0,
            end: RANGE_WINDOW_BYTES - 1,
        });
    });

    it("caps from wherever the player seeked to, not from zero", () => {
        expect(parseRange("bytes=300000000-", SIZE)).toEqual({
            start: 300_000_000,
            end: 300_000_000 + RANGE_WINDOW_BYTES - 1,
        });
    });

    it("does not cap an open range that ends inside the window anyway", () => {
        const start = SIZE - 1024;

        expect(parseRange(`bytes=${start}-`, SIZE)).toEqual({
            start,
            end: SIZE - 1,
        });
    });

    it("honours an explicit end, however large", () => {
        const end = RANGE_WINDOW_BYTES * 4;

        expect(parseRange(`bytes=0-${end}`, SIZE)).toEqual({ start: 0, end });
    });

    it("clamps an explicit end past the last byte", () => {
        expect(parseRange(`bytes=0-${SIZE + 500}`, SIZE)).toEqual({
            start: 0,
            end: SIZE - 1,
        });
    });

    it("reads a suffix range from the end of the file", () => {
        expect(parseRange("bytes=-500", SIZE)).toEqual({
            start: SIZE - 500,
            end: SIZE - 1,
        });
    });

    it("gives the whole file for a suffix longer than it", () => {
        expect(parseRange(`bytes=-${SIZE + 1}`, SIZE)).toEqual({
            start: 0,
            end: SIZE - 1,
        });
    });

    it("refuses a range that starts past the end", () => {
        expect(parseRange(`bytes=${SIZE}-`, SIZE)).toBe("unsatisfiable");
        expect(parseRange("bytes=-0", SIZE)).toBe("unsatisfiable");
        expect(parseRange("bytes=500-100", SIZE)).toBe("unsatisfiable");
    });

    /**
     * A zero-length file has no satisfiable range at all, and the arithmetic must not invent
     * one: `size - 1` is -1, and a `Content-Range` of `bytes 0--1` is what a naive version
     * sends.
     */
    it("refuses every range on an empty file", () => {
        expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
        expect(parseRange("bytes=-10", 0)).toBe("unsatisfiable");
    });
});
