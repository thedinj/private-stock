import { describe, expect, it } from "vitest";

import { candidateOffsets } from "./cover.js";

/**
 * Where a cover comes from is arithmetic on a duration that is frequently wrong, missing, or
 * absurd — ffprobe reports nothing for a truncated download and reports nonsense for some
 * MKVs. A negative or past-the-end seek produces no frame, so an item with a bad duration
 * would silently end up with no picture at all.
 */
describe("candidateOffsets", () => {
    it("samples across the video, starting around a tenth in", () => {
        const offsets = candidateOffsets(600_000);

        expect(offsets).toHaveLength(5);
        // Not from the start: openings are logos, fades and title cards.
        expect(offsets[0]).toBeGreaterThan(0);
        expect(offsets[0]).toBeLessThan(120_000);
    });

    it("never seeks to or past the end", () => {
        for (const duration of [1, 500, 999, 1_000, 1_001, 2_500, 600_000]) {
            for (const offset of candidateOffsets(duration)) {
                expect(offset).toBeGreaterThanOrEqual(0);
                expect(offset).toBeLessThan(duration);
            }
        }
    });

    it("increases monotonically, so the first candidate is the earliest", () => {
        const offsets = candidateOffsets(600_000);

        for (let i = 1; i < offsets.length; i += 1) {
            expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
        }
    });

    it("falls back to fixed offsets when the duration is unknown or nonsense", () => {
        // An unprobed or malformed file still deserves an attempt; an offset past the end
        // simply yields no frame and is handled as a failed candidate, not a failed job.
        for (const duration of [null, 0, -1]) {
            const offsets = candidateOffsets(duration);

            expect(offsets).toHaveLength(5);
            expect(offsets.every((offset) => offset > 0)).toBe(true);
        }
    });
});
