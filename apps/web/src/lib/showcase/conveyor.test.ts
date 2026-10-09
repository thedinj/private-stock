import { describe, expect, it } from "vitest";

import { type ConveyorSpan, normalize, pageOfBlock, placeBlocks, shouldWrap } from "./conveyor";

const VIEWPORT = 1000;

/** Every page laid out at the same height, and every one of them fetched. */
const uniform =
    (height: number, span: ConveyorSpan) =>
    (block: number): number | undefined =>
        span.wrap || (block >= 0 && (span.pageCount === null || block < span.pageCount))
            ? height
            : undefined;

describe("pageOfBlock", () => {
    it("wraps in both directions", () => {
        const span = { pageCount: 3, wrap: true };

        expect([-4, -1, 0, 2, 3, 7].map((block) => pageOfBlock(block, span))).toEqual([
            2, 2, 0, 2, 0, 1,
        ]);
    });

    it("is the block itself when not wrapping", () => {
        expect(pageOfBlock(5, { pageCount: null, wrap: false })).toBe(5);
    });
});

describe("shouldWrap", () => {
    it("wraps a multi-page set, and not one whose length is unknown", () => {
        expect(shouldWrap(2, 5000, VIEWPORT)).toBe(true);
        expect(shouldWrap(null, 5000, VIEWPORT)).toBe(false);
    });

    it("leaves a set that fits on a screen or two standing still", () => {
        expect(shouldWrap(1, 1500, VIEWPORT)).toBe(false);
        expect(shouldWrap(1, 2500, VIEWPORT)).toBe(true);
    });
});

describe("normalize", () => {
    it("moves the anchor forward past the end and round to the start", () => {
        const span = { pageCount: 3, wrap: true };
        const position = normalize({ block: 2, offset: 5300 }, uniform(3000, span), span, VIEWPORT);

        expect(position).toEqual({ block: 3, offset: 2300 });
        expect(pageOfBlock(position.block, span)).toBe(0);
    });

    it("moves backward before the start when wrapping", () => {
        const span = { pageCount: 3, wrap: true };
        const position = normalize({ block: 0, offset: -500 }, uniform(3000, span), span, VIEWPORT);

        expect(position).toEqual({ block: -1, offset: 2500 });
        expect(pageOfBlock(position.block, span)).toBe(2);
    });

    it("stops at the top and bottom of a set that does not wrap", () => {
        const span = { pageCount: 2, wrap: false };
        const heightOf = uniform(3000, span);

        expect(normalize({ block: 0, offset: -400 }, heightOf, span, VIEWPORT)).toEqual({
            block: 0,
            offset: 0,
        });
        // The bottom of the viewport meets the bottom of the last block.
        expect(normalize({ block: 1, offset: 2900 }, heightOf, span, VIEWPORT)).toEqual({
            block: 1,
            offset: 2000,
        });
    });

    it("does not cross into a block that has not been fetched", () => {
        const span = { pageCount: 5, wrap: true };
        const heightOf = (block: number) => (block === 0 ? 3000 : undefined);

        expect(normalize({ block: 0, offset: 2800 }, heightOf, span, VIEWPORT)).toEqual({
            block: 0,
            offset: 2000,
        });
    });

    it("pins a set shorter than the screen to the top", () => {
        const span = { pageCount: 1, wrap: false };

        expect(normalize({ block: 0, offset: 300 }, uniform(600, span), span, VIEWPORT)).toEqual({
            block: 0,
            offset: 0,
        });
    });

    it("walks past empty blocks without spinning", () => {
        const span = { pageCount: 3, wrap: true };
        const heightOf = (block: number) => ([0, 0, 0].includes(block) ? 0 : undefined);

        expect(normalize({ block: 0, offset: 50 }, heightOf, span, VIEWPORT).offset).toBe(0);
    });
});

describe("placeBlocks", () => {
    it("places the blocks overlapping the viewport and its margins", () => {
        const span = { pageCount: 4, wrap: true };
        const { blocks, missing } = placeBlocks(
            { block: 1, offset: 200 },
            uniform(1000, span),
            span,
            VIEWPORT,
            500,
            1500
        );

        expect(blocks).toEqual([
            { block: 0, top: -1200 },
            { block: 1, top: -200 },
            { block: 2, top: 800 },
            { block: 3, top: 1800 },
        ]);
        expect(missing).toEqual([]);
    });

    it("reports the neighbours it needed and did not have", () => {
        const span = { pageCount: 4, wrap: true };
        const { blocks, missing } = placeBlocks(
            { block: 1, offset: 0 },
            (block) => (block === 1 ? 800 : undefined),
            span,
            VIEWPORT,
            200,
            200
        );

        expect(blocks).toEqual([{ block: 1, top: 0 }]);
        expect(missing).toEqual([0, 2]);
    });

    it("asks for nothing past the ends of a set that does not wrap", () => {
        const span = { pageCount: 1, wrap: false };
        const { missing } = placeBlocks(
            { block: 0, offset: 0 },
            uniform(500, span),
            span,
            VIEWPORT,
            500,
            500
        );

        expect(missing).toEqual([]);
    });
});
