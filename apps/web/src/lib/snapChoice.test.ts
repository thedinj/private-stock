import { describe, expect, it } from "vitest";

import { snapChoice } from "./snapChoice";
import { DEFAULT_CLIP_SECONDS, TASTING_LENGTHS, snapTastingSeconds } from "./tasting/lengths";

describe("snapChoice", () => {
    it("keeps every offered value, as a number or out of storage", () => {
        for (const choice of TASTING_LENGTHS) {
            expect(snapChoice(choice, TASTING_LENGTHS, 10)).toBe(choice);
            expect(snapChoice(String(choice), TASTING_LENGTHS, 10)).toBe(choice);
        }
    });

    it("gives the fallback for anything that is not a number", () => {
        for (const value of [null, undefined, "", "  ", "NaN", "abc", Number.NaN, Infinity]) {
            expect(snapChoice(value, TASTING_LENGTHS, 10)).toBe(10);
        }
    });

    it("snaps to the nearest choice, the earlier one on a tie", () => {
        expect(snapChoice(0, TASTING_LENGTHS, 10)).toBe(5);
        expect(snapChoice(-40, TASTING_LENGTHS, 10)).toBe(5);
        expect(snapChoice(1e9, TASTING_LENGTHS, 10)).toBe(60);
        expect(snapChoice(7.5, TASTING_LENGTHS, 10)).toBe(5);
        expect(snapChoice(8, TASTING_LENGTHS, 10)).toBe(10);
        expect(snapChoice(45, TASTING_LENGTHS, 10)).toBe(30);
    });

    it("carries a tasting length's own fallback", () => {
        expect(snapTastingSeconds(null, DEFAULT_CLIP_SECONDS)).toBe(DEFAULT_CLIP_SECONDS);
        expect(snapTastingSeconds("20", DEFAULT_CLIP_SECONDS)).toBe(20);
    });
});
