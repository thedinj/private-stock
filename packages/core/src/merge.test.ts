import { describe, expect, it } from "vitest";

import {
    EMPTY_OVERLAY,
    mergeNotes,
    mergeOverlay,
    NOTE_MAX_LENGTH,
    overlayEquals,
    type UserOverlay,
} from "./merge.js";

const overlay = (fields: Partial<UserOverlay>): UserOverlay => ({ ...EMPTY_OVERLAY, ...fields });

describe("merging one viewer's two records", () => {
    it("keeps the higher rating, whichever copy carried it", () => {
        expect(mergeOverlay(overlay({ rating: 2 }), overlay({ rating: 5 })).rating).toBe(5);
        expect(mergeOverlay(overlay({ rating: 5 }), overlay({ rating: 2 })).rating).toBe(5);
    });

    it("leaves an unrated pair unrated rather than rating it zero", () => {
        expect(mergeOverlay(EMPTY_OVERLAY, EMPTY_OVERLAY).rating).toBeNull();
    });

    it("keeps a favourite marked from either side", () => {
        expect(
            mergeOverlay(overlay({ favorite: false }), overlay({ favorite: true })).favorite
        ).toBe(true);
        expect(
            mergeOverlay(overlay({ favorite: true }), overlay({ favorite: false })).favorite
        ).toBe(true);
    });

    /**
     * The one field that deliberately does not flow.
     *
     * Hiding a copy *because* it is a duplicate is the commonest reason to hide anything, so
     * inheriting it would make the copy somebody chose to keep disappear at the moment they
     * tidied up — a merge that reads as the wrong file having been deleted.
     */
    it("never hides the surviving copy on the strength of the departing one", () => {
        expect(mergeOverlay(overlay({ hidden: false }), overlay({ hidden: true })).hidden).toBe(
            false
        );
    });

    it("still keeps the survivor hidden when it was hidden in its own right", () => {
        expect(mergeOverlay(overlay({ hidden: true }), overlay({ hidden: false })).hidden).toBe(
            true
        );
    });

    /**
     * The sum would be the truer number, and it is the one rule that cannot survive a repeat:
     * trash, restore and trash again would count the same views twice.
     */
    it("takes the higher view count rather than adding them", () => {
        expect(mergeOverlay(overlay({ viewCount: 3 }), overlay({ viewCount: 4 })).viewCount).toBe(
            4
        );
    });

    it("remembers when the item was first finished, not most recently", () => {
        const merged = mergeOverlay(
            overlay({ watchedAt: "2026-05-01 10:00:00" }),
            overlay({ watchedAt: "2024-01-01 10:00:00" })
        );

        expect(merged.watchedAt).toBe("2024-01-01 10:00:00");
    });

    it("marks the survivor watched when only the departing copy was", () => {
        expect(
            mergeOverlay(EMPTY_OVERLAY, overlay({ watchedAt: "2025-02-02 09:00:00" })).watchedAt
        ).toBe("2025-02-02 09:00:00");
    });

    describe("last viewed", () => {
        it("is the later of the two", () => {
            const merged = mergeOverlay(
                overlay({ lastViewedAt: "2026-01-01 10:00:00" }),
                overlay({ lastViewedAt: "2026-03-01 10:00:00" })
            );

            expect(merged.lastViewedAt).toBe("2026-03-01 10:00:00");
        });

        it("comes from a copy the survivor was never viewed in", () => {
            const merged = mergeOverlay(
                EMPTY_OVERLAY,
                overlay({ lastViewedAt: "2026-01-01 10:00:00" })
            );

            expect(merged.lastViewedAt).toBe("2026-01-01 10:00:00");
        });
    });

    /**
     * A group of three is two deletions, and somebody may work through it in either order —
     * or delete, restore and delete again. Neither must change where the library ends up.
     */
    it("reaches the same answer whichever copy is eliminated first", () => {
        const a = overlay({ rating: 4, viewCount: 1, watchedAt: "2025-01-01 00:00:00" });
        const b = overlay({ favorite: true, viewCount: 2, note: "the good one" });
        const c = overlay({ rating: 5, viewCount: 3, watchedAt: "2024-06-01 00:00:00" });

        const aFirst = mergeOverlay(mergeOverlay(c, a), b);
        const bFirst = mergeOverlay(mergeOverlay(c, b), a);

        expect(aFirst).toEqual(bFirst);
    });

    it("changes nothing when it runs a second time", () => {
        const heir = overlay({ rating: 3, note: "keep" });
        const departing = overlay({ rating: 5, favorite: true, note: "also keep", viewCount: 2 });

        const once = mergeOverlay(heir, departing);

        expect(overlayEquals(mergeOverlay(once, departing), once)).toBe(true);
    });
});

describe("merging two notes", () => {
    it("keeps both, the survivor's first", () => {
        expect(mergeNotes("mine", "theirs")).toBe("mine\n\ntheirs");
    });

    it("takes the departing note when the survivor has none", () => {
        expect(mergeNotes(null, "theirs")).toBe("theirs");
        expect(mergeNotes("   ", "theirs")).toBe("theirs");
    });

    it("leaves the survivor's note alone when there is nothing to add", () => {
        expect(mergeNotes("mine", null)).toBe("mine");
        expect(mergeNotes(null, null)).toBeNull();
    });

    it("does not stack the same paragraph up on a repeat merge", () => {
        const once = mergeNotes("mine", "theirs");

        expect(mergeNotes(once, "theirs")).toBe(once);
        expect(mergeNotes("mine", "mine")).toBe("mine");
    });

    it("trims the pair rather than dropping one of them", () => {
        const merged = mergeNotes("a".repeat(1_900), "b".repeat(1_900));

        expect(merged).toHaveLength(NOTE_MAX_LENGTH);
        expect(merged?.startsWith("a".repeat(1_900))).toBe(true);
    });
});
