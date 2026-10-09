import { describe, expect, it } from "vitest";

import {
    DEFAULT_THROTTLE_SETTINGS,
    inWindow,
    isThrottled,
    throttleChangesAt,
    throttleSettingsSchema,
    throttledThreads,
} from "./throttle.js";

/**
 * The window arithmetic (§7c).
 *
 * Every test here is a boundary. A throttling window has exactly two edges and both of them
 * are off-by-one bait, and the failure mode is not a crash -- it is a setting that looks
 * configured and does nothing, or one that never lifts.
 */

const settings = (overrides: Partial<Record<string, unknown>> = {}) =>
    throttleSettingsSchema.parse({ enabled: true, startHour: 2, endHour: 8, ...overrides });

describe("inWindow", () => {
    it("includes the start hour and excludes the end hour", () => {
        expect(inWindow(1, 2, 8)).toBe(false);
        expect(inWindow(2, 2, 8)).toBe(true);
        expect(inWindow(7, 2, 8)).toBe(true);
        expect(inWindow(8, 2, 8)).toBe(false);
    });

    /**
     * The case a naive `hour >= start && hour < end` gets silently wrong.
     *
     * `22 -> 06` is the obvious setting for a home NAS, and under the naive comparison it
     * matches no hour of the day: the throttle would be on, configured, and never once lift.
     */
    it("wraps across midnight", () => {
        expect(inWindow(21, 22, 6)).toBe(false);
        expect(inWindow(22, 22, 6)).toBe(true);
        expect(inWindow(23, 22, 6)).toBe(true);
        expect(inWindow(0, 22, 6)).toBe(true);
        expect(inWindow(5, 22, 6)).toBe(true);
        expect(inWindow(6, 22, 6)).toBe(false);
    });

    it("covers every hour of the day exactly once across the two branches", () => {
        const hours = Array.from({ length: 24 }, (_, hour) => hour);

        // A window and its complement must partition the day: no hour both throttled and
        // free, none neither.
        for (const hour of hours) {
            expect(inWindow(hour, 2, 8)).toBe(!inWindow(hour, 8, 2));
        }
    });
});

describe("throttleSettingsSchema", () => {
    it("refuses a window whose start and end are the same", () => {
        // Ambiguous rather than harmless: it could mean "always" or "never", and a setting
        // that saves cleanly and then does nothing is worse than one that refuses.
        expect(() => settings({ endHour: 2 })).toThrow();
    });

    it("is off by default, so a fresh install catalogues at full speed", () => {
        expect(DEFAULT_THROTTLE_SETTINGS.enabled).toBe(false);
    });
});

describe("isThrottled", () => {
    it("holds work back outside the window and lets it run inside", () => {
        expect(isThrottled(settings(), 3)).toBe(false);
        expect(isThrottled(settings(), 14)).toBe(true);
    });

    it("never throttles while the feature is switched off", () => {
        const off = settings({ enabled: false });

        expect(Array.from({ length: 24 }, (_, hour) => isThrottled(off, hour))).not.toContain(true);
    });
});

describe("throttleChangesAt", () => {
    it("counts down to the end of the window while inside it", () => {
        expect(throttleChangesAt(settings(), 3)).toBe(8);
    });

    it("counts down to the start of the window while outside it", () => {
        expect(throttleChangesAt(settings(), 14)).toBe(2);
    });

    it("has nothing to announce when the feature is off", () => {
        expect(throttleChangesAt(settings({ enabled: false }), 14)).toBeNull();
    });
});

describe("throttledThreads", () => {
    it("halves the core count by default", () => {
        expect(throttledThreads(settings(), 4)).toBe(2);
        expect(throttledThreads(settings(), 8)).toBe(4);
    });

    /**
     * `-threads 0` means "use every core" to ffmpeg, so flooring at one is not tidiness --
     * it is the difference between a capped encode and an uncapped one, on exactly the
     * machines least able to absorb it.
     */
    it("never yields zero, which ffmpeg reads as unlimited", () => {
        expect(throttledThreads(settings({ threadShare: 0.1 }), 1)).toBe(1);
        expect(throttledThreads(settings({ threadShare: 0.25 }), 2)).toBe(1);
        expect(throttledThreads(settings(), 0)).toBe(1);
    });

    it("gives the whole box at a share of one", () => {
        expect(throttledThreads(settings({ threadShare: 1 }), 6)).toBe(6);
    });
});
