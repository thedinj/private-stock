import { describe, expect, it } from "vitest";

import { ratingAfterPressing, ratingWhilePending } from "./userMedia";

/**
 * What a number key means, given what is already stored (§6, §14b).
 *
 * Pure, and shared by the two controls that set a rating: the stars and the numpad. The rule
 * is discovered by trying it rather than read anywhere, so the two must behave identically —
 * a keyboard that could not take a rating back, when the mouse could, would read as the
 * keyboard being broken.
 */

describe("pressing a rating", () => {
    it("sets it when it differs from what is stored", () => {
        expect(ratingAfterPressing(4, null)).toBe(4);
        expect(ratingAfterPressing(4, 2)).toBe(4);
    });

    /**
     * The same one again takes it back. This is the only route to unrated: there is no
     * "clear" control, by design — the gesture is the same one that set it.
     */
    it("clears it when it is the one already given", () => {
        expect(ratingAfterPressing(3, 3)).toBeNull();
    });

    it("has nothing to take back when nothing is stored", () => {
        // A first press is always a set, so no number can arrive at null from unrated.
        for (const pressed of [1, 2, 3, 4, 5]) {
            expect(ratingAfterPressing(pressed, null)).toBe(pressed);
        }
    });
});

/**
 * What the stars show while a patch is in flight.
 *
 * The bug this exists for: clearing sends `{ rating: null }`, and `variables?.rating ??
 * stored` reads that as "no rating was sent" and falls back to the rating being cleared. The
 * write was always right; the stars simply did not move until the round trip returned, and a
 * control that does the right thing while showing the wrong thing cannot be told apart from
 * one that does nothing. On a NAS that window is long enough to conclude the feature is
 * missing.
 */
describe("what the stars show mid-flight", () => {
    it("shows a rating that has been sent but not yet confirmed", () => {
        expect(ratingWhilePending(null, { rating: 4 })).toBe(4);
        expect(ratingWhilePending(2, { rating: 4 })).toBe(4);
    });

    it("shows a clear that has been sent but not yet confirmed", () => {
        // The case `??` got wrong: null is a value here, not an absence.
        expect(ratingWhilePending(3, { rating: null })).toBeNull();
    });

    it("leaves the rating alone for a patch that says nothing about it", () => {
        // Marking a favourite must not blank the stars on the way past.
        expect(ratingWhilePending(3, { favorite: true })).toBe(3);
    });

    it("shows what is stored when nothing is in flight", () => {
        expect(ratingWhilePending(3, undefined)).toBe(3);
        expect(ratingWhilePending(null, undefined)).toBeNull();
    });

    /**
     * Pressing the same star twice, end to end: the rule that decides what to send, and the
     * rule that decides what to show while it is being sent. They were written apart, and
     * the second one is where clearing broke.
     */
    it("clears and looks cleared, in one gesture", () => {
        const stored = 3;
        const sent = { rating: ratingAfterPressing(3, stored) };

        expect(sent.rating).toBeNull();
        expect(ratingWhilePending(stored, sent)).toBeNull();
    });
});
