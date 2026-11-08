import { describe, expect, it } from "vitest";

import { pinSchema } from "@private-stock/core";

import {
    canTry,
    PIN_MAX_DIGITS,
    PIN_MIN_DIGITS,
    RACK_DIGITS,
    vintageOf,
    withDigit,
} from "./pinDigits";

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

    it("has every digit once, each on a vintage ending in it", () => {
        expect([...RACK_DIGITS].sort()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
        RACK_DIGITS.forEach((digit) => expect(vintageOf(digit).endsWith(digit)).toBe(true));
    });
});
