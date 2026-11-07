import { describe, expect, it, vi } from "vitest";

let room = "cellar";
vi.mock("./activeDomain", () => ({ getActiveDomain: () => room }));

const { facetLabel, facetLabelPlural } = await import("./facetLabels");

/**
 * The one place a facet gets its name (§5b).
 *
 * Worth a test for two reasons. The catch-all is displayed under a different word from the one
 * it is stored as, so a table that fell back to the stored name would quietly undo the rename
 * and nothing would fail; and `kind` is an open string, so the fallback is the only thing
 * standing between a retired facet and a tag nobody can see to remove.
 */

describe("naming a facet", () => {
    it("shows the catch-all as a keyword, not as a tag", () => {
        expect(facetLabel("tag")).toBe("Keyword");
        expect(facetLabelPlural("tag")).toBe("Keywords");
    });

    it("names the other two", () => {
        expect(facetLabel("performer")).toBe("Performer");
        expect(facetLabelPlural("source")).toBe("Sources");
    });

    it("names them as the room does (§21)", () => {
        room = "family";
        expect(facetLabelPlural("performer")).toBe("People");

        room = "games";
        expect(facetLabel("performer")).toBe("Player");
        expect(facetLabel("source")).toBe("Game");
        expect(facetLabel("tag")).toBe("Keyword");

        room = "cellar";
    });

    it("falls back to a facet's own name rather than hiding it", () => {
        expect(facetLabel("director")).toBe("Director");
        expect(facetLabelPlural("director")).toBe("Director");
    });

    it("survives a stored name nothing would produce", () => {
        expect(facetLabel("")).toBe("");
    });
});
