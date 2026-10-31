import { describe, expect, it } from "vitest";

import {
    DEFAULT_SKIP_BACK,
    DEFAULT_SKIP_FORWARD,
    SKIP_BACK_CHOICES,
    SKIP_FORWARD_CHOICES,
    snapSkipBack,
    snapSkipForward,
} from "./skipLengths";

/**
 * The jump lengths read back out of storage (§14b). Whatever is stored, the player must jump by a
 * length the chooser offers -- never zero, never a hand-edited hour.
 */

describe("skip lengths", () => {
    it("keeps every offered length as it is", () => {
        for (const seconds of SKIP_BACK_CHOICES) {
            expect(snapSkipBack(String(seconds))).toBe(seconds);
        }

        for (const seconds of SKIP_FORWARD_CHOICES) {
            expect(snapSkipForward(String(seconds))).toBe(seconds);
        }
    });

    it("offers a one-second step back", () => {
        expect(SKIP_BACK_CHOICES[0]).toBe(1);
    });

    it("falls back to ten each way when nothing usable is stored", () => {
        expect(snapSkipBack(null)).toBe(DEFAULT_SKIP_BACK);
        expect(snapSkipBack("")).toBe(DEFAULT_SKIP_BACK);
        expect(snapSkipForward("NaN")).toBe(DEFAULT_SKIP_FORWARD);
        expect(DEFAULT_SKIP_BACK).toBe(10);
        expect(DEFAULT_SKIP_FORWARD).toBe(10);
    });

    it("snaps anything else into its own set", () => {
        expect(snapSkipBack("0")).toBe(1);
        expect(snapSkipBack("3600")).toBe(30);
        expect(snapSkipForward("1")).toBe(5);
        expect(snapSkipForward("3600")).toBe(90);
    });
});
