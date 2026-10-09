import { describe, expect, it } from "vitest";

import { activeFilters } from "./activeFilters";
import { DEFAULT_VIEW, withLook } from "./libraryQuery";

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
