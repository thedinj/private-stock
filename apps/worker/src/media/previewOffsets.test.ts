import { describe, expect, it } from "vitest";

import { PREVIEW_SEGMENTS, previewOffsets } from "./clips.js";

describe("previewOffsets", () => {
    it("spreads a film's samples across the whole of it, short of the credits", () => {
        const offsets = previewOffsets(600_000);

        expect(offsets).toHaveLength(PREVIEW_SEGMENTS);
        expect(offsets[0]).toBeLessThan(60_000);
        expect(offsets.at(-1)).toBeLessThan(600_000 * 0.9);
    });

    it("takes a Game Room recording's from its last ten seconds, the last ending at the end (§21)", () => {
        const offsets = previewOffsets(30_000, 10_000);

        expect(offsets).toHaveLength(PREVIEW_SEGMENTS);
        expect(offsets[0]).toBe(20_000);
        expect(offsets.at(-1)).toBe(29_000);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    });

    it("uses the whole of a recording shorter than its tail", () => {
        const offsets = previewOffsets(4_000, 10_000);

        expect(offsets[0]).toBe(0);
        expect(Math.max(...offsets)).toBe(3_000);
    });
});
