import { describe, expect, it } from "vitest";

import { MAX_ASPECT, MIN_ASPECT, justify, tileAspect } from "./justify";

const WIDTH = 1000;
const GAP = 4;

const rowWidth = (row: { tiles: { x: number; width: number }[] }): number => {
    const last = row.tiles[row.tiles.length - 1];

    return last.x + last.width - row.tiles[0].x;
};

describe("tileAspect", () => {
    it("falls back to 16:9 when the dimensions are unknown", () => {
        expect(tileAspect(null, 1080)).toBeCloseTo(16 / 9);
        expect(tileAspect(0, 0)).toBeCloseTo(16 / 9);
    });

    it("clamps extreme shapes so no row fills with slivers", () => {
        expect(tileAspect(100, 1000)).toBe(MIN_ASPECT);
        expect(tileAspect(4000, 1000)).toBe(MAX_ASPECT);
    });
});

describe("justify", () => {
    it("spans every row across the width exactly", () => {
        const aspects = Array.from({ length: 200 }, (_, i) => [16 / 9, 4 / 3, 0.75, 2][i % 4]);
        const block = justify(aspects, WIDTH, 200, GAP);

        for (const row of block.rows) {
            expect(rowWidth(row)).toBeCloseTo(WIDTH, 6);
        }
    });

    it("places every item exactly once, in order", () => {
        const aspects = Array.from({ length: 57 }, () => 16 / 9);
        const block = justify(aspects, WIDTH, 200, GAP);

        expect(block.rows.flatMap((row) => row.tiles.map((tile) => tile.index))).toEqual(
            aspects.map((_, i) => i)
        );
    });

    it("stacks rows with the gap between them, and under the last", () => {
        const block = justify(
            Array.from({ length: 30 }, () => 1.5),
            WIDTH,
            200,
            GAP
        );

        block.rows.forEach((row, i) => {
            if (i > 0) {
                const previous = block.rows[i - 1];

                expect(row.y).toBeCloseTo(previous.y + previous.height + GAP);
            }
        });

        const last = block.rows[block.rows.length - 1];

        expect(block.height).toBeCloseTo(last.y + last.height + GAP);
    });

    /**
     * The block's leftovers fold into the row above rather than becoming a banner.
     *
     * Blocks are laid out one page at a time and butt against each other, so a ragged or giant
     * last row would show as a seam every two hundred items.
     */
    it("folds a short last row into its neighbour instead of stretching it", () => {
        // Five tiles fill a row at this height; the sixth is alone.
        const block = justify(
            Array.from({ length: 6 }, () => 1),
            WIDTH,
            196,
            GAP
        );

        expect(block.rows).toHaveLength(1);
        expect(block.rows[0].tiles).toHaveLength(6);
        expect(rowWidth(block.rows[0])).toBeCloseTo(WIDTH, 6);
    });

    it("centres a set too small to fill a row at a sane height", () => {
        const block = justify([16 / 9], WIDTH, 200, GAP);
        const [row] = block.rows;

        expect(row.height).toBeLessThanOrEqual(200 * 1.6);
        expect(row.tiles[0].x).toBeCloseTo((WIDTH - row.tiles[0].width) / 2);
    });

    it("lays out nothing for no items or no width", () => {
        expect(justify([], WIDTH, 200, GAP)).toEqual({ rows: [], height: 0 });
        expect(justify([1], 0, 200, GAP)).toEqual({ rows: [], height: 0 });
    });
});
