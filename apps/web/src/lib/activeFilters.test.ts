import { describe, expect, it } from "vitest";

import { activeFilters } from "./activeFilters";
import { DEFAULT_VIEW, withDateRange, withLook } from "./libraryQuery";

/** The chips a look puts above the grid (§5e), and the parts a long name is cut between. */
describe("look chips", () => {
    const title = "A very long file name 2026-03-12 21-04-33 final export (copy).mp4";

    it("names the item a moment came from, with the name apart so it can be cut", () => {
        const [chip] = activeFilters(
            withLook(DEFAULT_VIEW, { like: "abc@250000" }),
            undefined,
            title
        );

        expect(chip.label).toBe(`Looks like “${title}” at 4:10`);
        expect(chip.named).toEqual({ before: "Looks like “", name: title, after: "” at 4:10" });
    });

    it("says a moment until the item's name arrives", () => {
        const [chip] = activeFilters(withLook(DEFAULT_VIEW, { like: "abc" }));

        expect(chip.label).toBe("Looks like a moment");
        expect(chip.named).toBeUndefined();
    });

    it("cuts long words the same way", () => {
        const [chip] = activeFilters(withLook(DEFAULT_VIEW, { lookText: "neon at night" }));

        expect(chip.named).toEqual({ before: "Looks like “", name: "neon at night", after: "”" });
        expect(chip.clear(withLook(DEFAULT_VIEW, { lookText: "neon" })).lookText).toBe("");
    });
});

/** The date chips (§14e "Dates"): one per date, in the words somebody would say it. */
describe("date chips", () => {
    const chipFor = (axis: "added" | "captured", from: string | null, to: string | null) =>
        activeFilters(withDateRange(DEFAULT_VIEW, axis, { from, to }));

    it.each([
        ["added", "2026-10-03", null, "Added since 3 Oct 2026"],
        ["added", null, "2026-10-03", "Added until 3 Oct 2026"],
        ["added", "2026-10-03", "2026-10-03", "Added on 3 Oct 2026"],
        ["captured", "2025-10-01", "2025-10-15", "Captured 1–15 Oct 2025"],
        ["captured", "2025-09-28", "2025-10-03", "Captured 28 Sep – 3 Oct 2025"],
        ["captured", "2025-12-28", "2026-01-03", "Captured 28 Dec 2025 – 3 Jan 2026"],
    ] as const)("%s %s to %s reads %j", (axis, from, to, label) => {
        const chips = chipFor(axis, from, to);

        expect(chips.map((chip) => chip.label)).toEqual([label]);
    });

    it("is one chip for both ends, and removing it clears only that date", () => {
        const view = withDateRange(
            withDateRange(DEFAULT_VIEW, "added", { from: "2026-10-01", to: "2026-10-31" }),
            "captured",
            { from: "2025-01-01", to: null }
        );
        const chips = activeFilters(view);

        expect(chips.map((chip) => chip.id)).toEqual(["date:added", "date:captured"]);

        const cleared = chips[0].clear(view);

        expect(cleared.dates.added).toEqual({ from: null, to: null });
        expect(cleared.dates.captured).toEqual({ from: "2025-01-01", to: null });
    });

    it("shows nothing for a date that is not set", () => {
        expect(activeFilters(DEFAULT_VIEW)).toEqual([]);
    });
});

/** The review pass chips (§14d): one per pass, in the words the panel uses. */
describe("review pass chips", () => {
    const names = {
        tag: () => undefined,
        root: () => undefined,
        reviewPass: (id: string) => ({ p1: "Players", p2: "Wins" })[id],
    };
    const view = { ...DEFAULT_VIEW, reviewedFor: ["p1"], notReviewedFor: ["p2", "gone"] };

    it("says which pass, and which way", () => {
        expect(activeFilters(view, names).map((chip) => chip.label)).toEqual([
            "Reviewed for Players",
            "Not yet reviewed for Wins",
            "Not yet reviewed for a review pass",
        ]);
    });

    it("clears only its own pass", () => {
        const wins = activeFilters(view, names).find((chip) => chip.id === "notReviewedFor:p2")!;

        expect(wins.clear(view)).toMatchObject({
            reviewedFor: ["p1"],
            notReviewedFor: ["gone"],
            page: 0,
        });
    });
});
