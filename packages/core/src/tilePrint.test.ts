import { describe, expect, it } from "vitest";

import {
    TILE_PRINT_BYTES,
    TILE_PRINT_SIDE,
    alignTilePrints,
    decodeTilePrints,
    durationsComparable,
    encodeTilePrints,
    prepareTilePrints,
    tilePrintFromRgb,
    tilesMatch,
    type TilePrints,
} from "./tilePrint.js";

/**
 * The offset-tolerant duplicate test (§10h).
 *
 * What these pin down is the shape of the measurement the thresholds came from: a copy that
 * starts a tile late still lines up, a different video does not, and flat tiles are neither
 * evidence for nor against.
 */

/** Deterministic noise, so a failure reproduces. */
const noise = (() => {
    let state = 0x9e3779b9;

    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

        return state / 2 ** 32;
    };
})();

const randomPrint = (): Uint8Array =>
    Uint8Array.from({ length: TILE_PRINT_BYTES }, () => Math.floor(noise() * 256));

/** The same picture through a different encoder: every cell nudged a little. */
const reencoded = (print: Uint8Array): Uint8Array =>
    Uint8Array.from(print, (value) =>
        Math.max(0, Math.min(255, value + Math.round((noise() - 0.5) * 16)))
    );

const video = (tiles: (Uint8Array | null)[], intervalMs = 7_000): TilePrints => ({
    intervalMs,
    tiles,
});

const align = (a: TilePrints, b: TilePrints) =>
    alignTilePrints(prepareTilePrints(a), prepareTilePrints(b));

describe("tilePrintFromRgb", () => {
    const square = (pixel: (x: number, y: number) => [number, number, number]): Uint8Array => {
        const rgb = new Uint8Array(TILE_PRINT_SIDE * TILE_PRINT_SIDE * 3);

        for (let y = 0; y < TILE_PRINT_SIDE; y += 1) {
            for (let x = 0; x < TILE_PRINT_SIDE; x += 1) {
                rgb.set(pixel(x, y), (y * TILE_PRINT_SIDE + x) * 3);
            }
        }

        return rgb;
    };

    it("averages each eighth of the square into one cell", () => {
        const print = tilePrintFromRgb(square((x) => (x < 8 ? [200, 10, 10] : [10, 10, 200])))!;

        expect(print).toHaveLength(TILE_PRINT_BYTES);
        expect([...print.subarray(0, 3)]).toEqual([200, 10, 10]);
        expect([...print.subarray(3, 6)]).toEqual([10, 10, 200]);
    });

    it("has no print for a flat tile, which every fade to black would otherwise match", () => {
        expect(tilePrintFromRgb(square(() => [3, 3, 3]))).toBeNull();
        expect(tilePrintFromRgb(square((x, y) => [(x + y) % 2, 0, 0]))).toBeNull();
    });
});

describe("alignTilePrints", () => {
    const original = Array.from({ length: 40 }, randomPrint);

    it("matches a re-encode tile for tile", () => {
        const result = align(video(original), video(original.map(reencoded)));

        expect(result.score).toBe(1);
        expect(tilesMatch(result, 3)).toBe(true);
    });

    it("matches a copy that starts a tile later, which is the case the hash misses", () => {
        const late = [randomPrint(), ...original.slice(0, -1)].map(reencoded);
        const result = align(video(original), video(late));

        expect(result.score).toBeGreaterThan(0.9);
        expect(tilesMatch(result, 3)).toBe(true);
    });

    it("does not match a different video", () => {
        const result = align(video(original), video(Array.from({ length: 40 }, randomPrint)));

        expect(tilesMatch(result, 3)).toBe(false);
    });

    it("pairs tiles by time when the two were cut at different intervals", () => {
        // 6 s and 7 s tiles of one 240 s video of 15 s shots: the same moments, at different
        // indexes.
        const shots = Array.from({ length: 16 }, randomPrint);
        const at = (intervalMs: number) =>
            Array.from({ length: Math.floor(240_000 / intervalMs) }, (_, i) =>
                reencoded(shots[Math.floor((i * intervalMs) / 15_000)])
            );

        expect(tilesMatch(align(video(at(6_000), 6_000), video(at(7_000), 7_000)), 3)).toBe(true);
    });

    it("leaves flat tiles out of the count rather than holding them against the pair", () => {
        const fades = original.map((print, i) => (i % 2 === 0 ? null : print));
        const result = align(video(fades), video(fades.map((p) => (p ? reencoded(p) : null))));

        expect(result.score).toBe(1);
    });

    it("needs enough matching tiles, however high the fraction", () => {
        const short = original.slice(0, 2);
        const result = align(video(short), video(short.map(reencoded)));

        expect(result.score).toBe(1);
        expect(tilesMatch(result, 3)).toBe(false);
    });
});

describe("durationsComparable", () => {
    it("allows one percent, or two seconds for a short video", () => {
        expect(durationsComparable(680_067, 681_643)).toBe(true);
        expect(durationsComparable(600_000, 607_000)).toBe(false);
        expect(durationsComparable(30_000, 32_000)).toBe(true);
        expect(durationsComparable(30_000, 32_500)).toBe(false);
    });
});

describe("the tile prints file", () => {
    it("round-trips, keeping a flat tile's slot so index still means time", () => {
        const prints = video([randomPrint(), null, randomPrint()], 4_000);
        const decoded = decodeTilePrints(encodeTilePrints(prints));

        expect(decoded.intervalMs).toBe(4_000);
        expect(decoded.tiles).toEqual(prints.tiles);
    });

    it("refuses a file it cannot read rather than guessing", () => {
        const bytes = encodeTilePrints(video([randomPrint()]));

        expect(() => decodeTilePrints(bytes.subarray(0, bytes.length - 1))).toThrow();
        expect(() => decodeTilePrints(new Uint8Array(20))).toThrow();
    });
});
