import { describe, expect, it } from "vitest";

import { parseView } from "./libraryQuery";
import { NO_SUMMARY_NAMES, summarizeSearch, type SummaryNames } from "./searchSummary";

/**
 * The sidebar's "Last search" line (§14b): a term and a count, in words that name the value
 * rather than the axis, and nothing at all for a library that is not searched.
 */

const names: SummaryNames = {
    tag: (id) => ({ t1: "Alice", t2: "Beach" })[id],
    root: (id) => (id === "r1" ? "Home videos" : undefined),
    savedFilter: (id) => (id === "f1" ? "Unrated 4K" : undefined),
};

const summary = (query: string, given: SummaryNames = names): string | null =>
    summarizeSearch(parseView(new URLSearchParams(query)), given);

describe("the last search, in a few words", () => {
    it("says nothing for the library as it opens, or one library as its row opens it", () => {
        expect(summary("view=grid")).toBeNull();
        expect(summary("view=grid&page=4")).toBeNull();
        expect(summary("root=r1")).toBeNull();
    });

    it("names a tag by itself, without saying what kind of filter it is", () => {
        expect(summary("view=grid&tags=t1")).toBe("Alice");
    });

    it("counts the rest rather than listing them", () => {
        expect(summary("view=grid&tags=t1,t2&favorite=1")).toBe("Alice +2");
    });

    it("puts what was typed first", () => {
        expect(summary("view=grid&tags=t1&search=sunset")).toBe("“sunset” +1");
    });

    it("counts the library a search is in, but last", () => {
        expect(summary("root=r1&tags=t1")).toBe("Alice +1");
    });

    it("says a saved view by its name alone", () => {
        expect(summary("view=grid&filter=f1&unrated=1&minResolution=2160")).toBe("Unrated 4K");
    });

    it("says a tag it has no name for as one", () => {
        expect(summary("view=grid&tags=t1", NO_SUMMARY_NAMES)).toBe("a tag");
    });

    it("says the sort only when it is the one thing that differs", () => {
        expect(summary("view=grid&sort=size")).toBe("File size · Largest");
        expect(summary("view=grid&sort=random")).toBe("Shuffle");
        expect(summary("view=grid&sort=size&tags=t1")).toBe("Alice");
    });

    it("counts the photos shelf as part of the search", () => {
        expect(summary("view=grid&kind=image")).toBe("Photos");
    });
});
