import { describe, expect, it } from "vitest";

import { LAST_USED_PASS, resolveReviewPass, reviewParam, withReview } from "./reviewMode";

describe("review mode on an item's address", () => {
    it("adds and removes itself, keeping the look's moment", () => {
        expect(withReview("/media/a", true)).toBe("/media/a?review=1");
        expect(withReview("/media/a?at=1200", true)).toBe("/media/a?at=1200&review=1");
        expect(withReview("/media/a?at=1200&review=1", false)).toBe("/media/a?at=1200");
        expect(withReview("/media/a?review=1", false)).toBe("/media/a");
    });

    it("carries a pass, replacing whichever was there", () => {
        expect(withReview("/media/a?review=1", "p2")).toBe("/media/a?review=p2");
        expect(withReview("/media/a?review=p1&at=5", "p2")).toBe("/media/a?review=p2&at=5");
    });

    it("is on only when the address says so", () => {
        expect(reviewParam(new URLSearchParams("review=1"))).toBe(LAST_USED_PASS);
        expect(reviewParam(new URLSearchParams("review=p1"))).toBe("p1");
        expect(reviewParam(new URLSearchParams("review="))).toBeNull();
        expect(reviewParam(new URLSearchParams("at=5"))).toBeNull();
    });
});

describe("which pass review mode is on", () => {
    const passes = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];

    it("is the one the address names", () => {
        expect(resolveReviewPass("p3", passes, "p2")?.id).toBe("p3");
    });

    it("is the last used for review=1, or for a pass that has gone", () => {
        expect(resolveReviewPass(LAST_USED_PASS, passes, "p2")?.id).toBe("p2");
        expect(resolveReviewPass("deleted", passes, "p2")?.id).toBe("p2");
    });

    it("falls back to the first, and is none without passes", () => {
        expect(resolveReviewPass(LAST_USED_PASS, passes, null)?.id).toBe("p1");
        expect(resolveReviewPass(LAST_USED_PASS, passes, "gone")?.id).toBe("p1");
        expect(resolveReviewPass(LAST_USED_PASS, [], "p2")).toBeNull();
    });
});
