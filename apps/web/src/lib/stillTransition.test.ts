import { describe, expect, it } from "vitest";

import { transitionFor, type StillTransition } from "./stillTransition";

/**
 * The only two things worth asserting about a decorative choice: that it does not move, and
 * that it actually varies.
 */

describe("how a picture arrives", () => {
    it("gives the same picture the same way in every time", () => {
        const id = "3f1c2b8a-5d4e-4f0a-9b7c-1e2d3c4b5a69";

        expect(transitionFor(id)).toBe(transitionFor(id));
    });

    it("uses all four across a set", () => {
        // Real-shaped ids rather than "a", "b", "c": the input is always a UUID, and a sum over
        // one character would hide a modulo that only works for long strings.
        const ids = Array.from(
            { length: 200 },
            (_, index) => `3f1c2b8a-5d4e-4f0a-9b7c-1e2d3c4b${String(index).padStart(4, "0")}`
        );

        const seen = new Set<StillTransition>(ids.map(transitionFor));

        expect(seen.size).toBe(4);
    });

    it("pins real ids, so changing the mix is a visible diff", () => {
        // Not an assertion about which variant is right — an assertion that nobody reshuffles
        // every picture in every library by accident. Three distinct outcomes, so a mix that
        // degenerated to one answer would fail here rather than merely look duller in use.
        expect(transitionFor("3f1c2b8a-5d4e-4f0a-9b7c-1e2d3c4b5a69")).toBe("fade");
        expect(transitionFor("7a9e4d31-0c2f-4b8e-a1d6-5f3b9c8e2a40")).toBe("drift");
        expect(transitionFor("d4c3b2a1-9f8e-4d7c-b6a5-4f3e2d1c0b9a")).toBe("veil");
    });

    it("does not collapse for an id whose digits are all the same", () => {
        // The bug in the first version: summed code units made every such id one variant,
        // because 32·digit + 180 is divisible by four whatever the digit.
        const uniform = "0123456789abcdef".split("").map((digit) => digit.repeat(32));
        const seen = new Set<StillTransition>(uniform.map(transitionFor));

        expect(seen.size).toBeGreaterThan(1);
    });
});
