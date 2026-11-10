import { describe, expect, it } from "vitest";

import { pinSchema } from "@private-stock/core";

import { canTry, PIN_MAX_DIGITS, PIN_MIN_DIGITS, vintageOf, withDigit } from "./pinDigits";
import { BOTTLES, TAGS } from "@/components/shell/wineRackLayout";

describe("pinDigits", () => {
    it("agrees with the schema about how long a PIN is", () => {
        expect(pinSchema.safeParse("1".repeat(PIN_MIN_DIGITS)).success).toBe(true);
        expect(pinSchema.safeParse("1".repeat(PIN_MIN_DIGITS - 1)).success).toBe(false);
        expect(pinSchema.safeParse("1".repeat(PIN_MAX_DIGITS)).success).toBe(true);
        expect(pinSchema.safeParse("1".repeat(PIN_MAX_DIGITS + 1)).success).toBe(false);
    });

    it("takes a repeated digit, which is why a bottle springs back", () => {
        expect(["1", "1", "2", "3"].reduce(withDigit, "")).toBe("1123");
    });

    it("stops at the longest PIN and ignores anything that is not a digit", () => {
        expect(withDigit("12345678", "9")).toBe("12345678");
        expect(withDigit("12", "x")).toBe("12");
    });

    it("only offers a try once there are enough digits", () => {
        expect(canTry("123")).toBe(false);
        expect(canTry("1234")).toBe(true);
    });

    it("has every digit once on the rack, each tagged with a vintage ending in it", () => {
        const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

        expect(BOTTLES.map((bottle) => bottle.digit).sort()).toEqual(digits);
        expect(TAGS.map((tag) => tag.digit).sort()).toEqual(digits);
        digits.forEach((digit) => expect(vintageOf(digit).endsWith(digit)).toBe(true));
    });

    it("lays the bottles out as a keypad: rows of three, the nought alone below", () => {
        const rows = [0, 3, 6].map((start) => BOTTLES.slice(start, start + 3));

        rows.forEach((row) => {
            expect(
                Math.max(...row.map((b) => b.top)) - Math.min(...row.map((b) => b.top))
            ).toBeLessThan(2);
            expect(row[0].left).toBeLessThan(row[1].left);
            expect(row[1].left).toBeLessThan(row[2].left);
        });
        expect(BOTTLES[9]).toMatchObject({ digit: "0" });
        expect(BOTTLES[9].top).toBeGreaterThan(rows[2][0].top);
    });
});
