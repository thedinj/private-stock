import { describe, expect, it } from "vitest";

import { findsUntagged, type FilterGroup } from "./filterLogic.js";
import { mediaQuerySchema, sortOverride, withSortOverride } from "./media.js";

/**
 * A "find untagged" list is shown by date added whatever it was sorted by (§14b, §20).
 *
 * The rule is about what the filter *implies* -- that every item in it is missing a tag -- so
 * the cases worth pinning are the groups that mention an untagged rule without implying it.
 */

const noPerformer = { t: "untagged", kind: "performer" } as const;
const noSource = { t: "untagged", kind: "source" } as const;
const fourStars = { t: "rating", min: 4 } as const;

const group = (match: FilterGroup["match"], ...rules: FilterGroup["rules"]): FilterGroup => ({
    match,
    rules,
});

describe("findsUntagged", () => {
    it("is true for the facet panel's untagged chip", () => {
        expect(findsUntagged([{ ...group("any", noPerformer), facet: "performer" }])).toBe(true);
    });

    it("is true for an all-of group with an untagged rule among others", () => {
        expect(findsUntagged([group("all", fourStars, noPerformer)])).toBe(true);
    });

    it("is true for an any-of group made only of untagged rules", () => {
        expect(findsUntagged([group("any", noPerformer, noSource)])).toBe(true);
    });

    it("is false for an any-of group that lets tagged items in through another rule", () => {
        expect(findsUntagged([group("any", noPerformer, fourStars)])).toBe(false);
    });

    it("is false for none-of, which asks for the tag instead", () => {
        expect(findsUntagged([group("none", noPerformer)])).toBe(false);
    });

    it("is true when any one group implies it, since groups are ANDed", () => {
        expect(findsUntagged([group("any", fourStars), group("all", noSource)])).toBe(true);
    });

    it("is false with no groups", () => {
        expect(findsUntagged(undefined)).toBe(false);
        expect(findsUntagged([])).toBe(false);
    });
});

describe("sortOverride and withSortOverride", () => {
    const untagged = [group("any", noPerformer)];

    it("shows a shuffled untagged list newest first, dropping the seed nothing reads", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "42", groups: untagged });

        expect(sortOverride(query)).toBe("addedAt");
        expect(withSortOverride(query)).toMatchObject({
            sort: "addedAt",
            direction: "desc",
            seed: undefined,
        });
    });

    it("overrides every other order too, a reversed one included", () => {
        for (const sort of ["size", "rating", "lastViewed", "title"] as const) {
            const query = mediaQuerySchema.parse({ sort, direction: "asc", groups: untagged });

            expect(withSortOverride(query)).toMatchObject({ sort: "addedAt", direction: "desc" });
        }
    });

    it("keeps date added in the direction the filter chose", () => {
        const query = mediaQuerySchema.parse({
            sort: "addedAt",
            direction: "asc",
            groups: untagged,
        });

        expect(sortOverride(query)).toBeNull();
        expect(withSortOverride(query)).toBe(query);
    });

    it("leaves every other filter's sort alone", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "7", favorite: "true" });

        expect(sortOverride(query)).toBeNull();
        expect(withSortOverride(query)).toBe(query);
    });
});
