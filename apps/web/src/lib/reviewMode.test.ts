import { describe, expect, it } from "vitest";

import { isReviewing, withReview } from "./reviewMode";

describe("review mode on an item's address", () => {
    it("adds and removes itself, keeping the look's moment", () => {
        expect(withReview("/media/a", true)).toBe("/media/a?review=1");
        expect(withReview("/media/a?at=1200", true)).toBe("/media/a?at=1200&review=1");
        expect(withReview("/media/a?at=1200&review=1", false)).toBe("/media/a?at=1200");
        expect(withReview("/media/a?review=1", false)).toBe("/media/a");
    });

    it("is on only when the address says so", () => {
        expect(isReviewing(new URLSearchParams("review=1"))).toBe(true);
        expect(isReviewing(new URLSearchParams("at=5"))).toBe(false);
    });
});
