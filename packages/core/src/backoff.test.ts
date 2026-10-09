import { describe, expect, it } from "vitest";

import { backoffDelayMs } from "./backoff.js";

const options = { free: 3, stepMs: 500, maxMs: 10_000 };

describe("backoffDelayMs", () => {
    it("costs nothing while the attempts are free", () => {
        expect(backoffDelayMs(1, options)).toBe(0);
        expect(backoffDelayMs(2, options)).toBe(0);
        expect(backoffDelayMs(3, options)).toBe(0);
    });

    it("starts at one step and doubles", () => {
        expect(backoffDelayMs(4, options)).toBe(500);
        expect(backoffDelayMs(5, options)).toBe(1_000);
        expect(backoffDelayMs(6, options)).toBe(2_000);
        expect(backoffDelayMs(7, options)).toBe(4_000);
        expect(backoffDelayMs(8, options)).toBe(8_000);
    });

    /**
     * The cap is a bound on held connections, not politeness. Without it a determined
     * attacker could make the server hold a socket open for hours per attempt, which is a
     * denial of service they get to choose the length of.
     */
    it("never waits longer than the cap", () => {
        expect(backoffDelayMs(9, options)).toBe(10_000);
        expect(backoffDelayMs(50, options)).toBe(10_000);
        expect(backoffDelayMs(5_000, options)).toBe(10_000);
    });

    /** `2 ** 5000` is `Infinity`, and `Math.min` with it would leave the cap intact — but the
     * clamped exponent means the multiplication never gets near that in the first place. */
    it("stays a finite number of milliseconds however many attempts are made", () => {
        expect(Number.isFinite(backoffDelayMs(Number.MAX_SAFE_INTEGER, options))).toBe(true);
    });

    it("treats a zero-free configuration as charging from the first attempt", () => {
        expect(backoffDelayMs(1, { free: 0, stepMs: 200, maxMs: 5_000 })).toBe(200);
    });
});
