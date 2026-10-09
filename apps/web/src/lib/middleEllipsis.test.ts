import { describe, expect, it } from "vitest";

import { splitForMiddleEllipsis } from "./middleEllipsis";

describe("splitForMiddleEllipsis", () => {
    it("keeps the end that tells a run of similar names apart", () => {
        expect(splitForMiddleEllipsis("FallGuys client 2026-03-12 21-04-33")).toEqual({
            head: "FallGuys client ",
            tail: "2026-03-12 21-04-33",
        });
    });

    it("splits at a space or a dot before a hyphen, so a date stays whole", () => {
        expect(splitForMiddleEllipsis("Studio.Name.Episode.Title.2019-06-01").tail).toBe(
            "Title.2019-06-01"
        );
    });

    it("falls back to a hyphen when no stronger boundary is in range", () => {
        expect(splitForMiddleEllipsis("averyverylongname-final-cut").tail).toBe("final-cut");
    });

    it("leaves a short name alone", () => {
        expect(splitForMiddleEllipsis("Summer Rain")).toEqual({ head: "Summer Rain", tail: "" });
    });

    it("does not cut a run-on name at an arbitrary letter", () => {
        const runOn = "FallGuysClient20260312210433";

        expect(splitForMiddleEllipsis(runOn)).toEqual({ head: runOn, tail: "" });
    });

    it("never starts the tail on a separator or leaves the head empty", () => {
        for (const text of [
            "a  b  c  d  e  f  g  h  i",
            "   leading spaces and more",
            "x.y.z.w.v.u.t.s.r.q",
        ]) {
            const { head, tail } = splitForMiddleEllipsis(text);

            expect(head + tail).toBe(text);
            expect(head.length).toBeGreaterThan(0);
            if (tail) expect(tail[0]).not.toMatch(/[\s._-]/);
        }
    });

    it("keeps the tail between 6 and 20 characters", () => {
        const { tail } = splitForMiddleEllipsis(
            "A very long title with many many words in it that goes on and on"
        );

        expect(tail.length).toBeGreaterThanOrEqual(6);
        expect(tail.length).toBeLessThanOrEqual(20);
    });
});
