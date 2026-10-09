import { describe, expect, it } from "vitest";

import { savedQuerySchema } from "@private-stock/core";

import { activeFilters } from "./activeFilters";
import {
    DEFAULT_VIEW,
    matchesSavedQuery,
    parseView,
    savedQueryToParams,
    viewToParams,
    viewToSavedQuery,
    type LibraryView,
} from "./libraryQuery";
import {
    advancedGroups,
    chipState,
    cycleChip,
    facetMode,
    favoritesOn,
    normalizeTagLogic,
    setChip,
    setFacetMode,
    cycleFavorites,
    cycleNone,
    favoritesState,
    noneState,
    setFavorites,
    setNone,
    withAdvancedGroups,
    withPicks,
} from "./tagLogic";

/**
 * The filter panel's tag chips as a state machine (§14e).
 *
 * The transitions are where this goes wrong without anybody noticing: a pick that lands in
 * the wrong list is still a filter, just a different one, and the grid looks plausible either
 * way. So each one is asserted on the view it produces, not on a rendered chip.
 */

const SON = "son";
const DAUGHTER = "daughter";
const AUNT = "aunt";
const BEACH = "beach";

const KINDS: Record<string, string> = {
    [SON]: "performer",
    [DAUGHTER]: "performer",
    [AUNT]: "performer",
    [BEACH]: "tag",
};
const kindOf = (tagId: string) => KINDS[tagId];

const view = (fields: Partial<LibraryView> = {}): LibraryView => ({
    ...DEFAULT_VIEW,
    mode: "grid",
    ...fields,
});

describe("a chip's three states", () => {
    it("goes off, with, without, off", () => {
        const on = cycleChip(view(), SON, "performer");

        expect(chipState(on, SON)).toBe("with");
        expect(on.tags).toEqual([SON]);

        const excluded = cycleChip(on, SON, "performer");

        expect(chipState(excluded, SON)).toBe("without");
        expect(excluded.tags).toEqual([]);
        expect(excluded.notTags).toEqual([SON]);

        const off = cycleChip(excluded, SON, "performer");

        expect(chipState(off, SON)).toBe("off");
        expect(off).toMatchObject({ tags: [], notTags: [], groups: [] });
    });

    it("lands a new pick in the facet's group when the facet is matching any", () => {
        const either = setFacetMode(view({ tags: [SON, DAUGHTER] }), "performer", "any", kindOf);
        const three = cycleChip(either, AUNT, "performer");

        expect(three.tags).toEqual([]);
        expect(three.groups).toEqual([
            {
                match: "any",
                facet: "performer",
                rules: [
                    { t: "tag", id: SON },
                    { t: "tag", id: DAUGHTER },
                    { t: "tag", id: AUNT },
                ],
            },
        ]);
    });

    it("resets the page, because a different filter is a different set", () => {
        expect(setChip(view({ page: 4 }), SON, "performer", "with").page).toBe(0);
    });
});

describe("all of, any of", () => {
    it("moves only that facet's picks into the group, and back", () => {
        const start = view({ tags: [SON, DAUGHTER, BEACH] });
        const any = setFacetMode(start, "performer", "any", kindOf);

        expect(facetMode(any, "performer")).toBe("any");
        // The keyword is another facet's, and stays a requirement.
        expect(any.tags).toEqual([BEACH]);

        const all = setFacetMode(any, "performer", "all", kindOf);

        expect(facetMode(all, "performer")).toBe("all");
        expect(all.groups).toEqual([]);
        expect([...all.tags].sort()).toEqual([BEACH, DAUGHTER, SON].sort());
    });

    it("falls back to all of once only one pick is left, since the two are then the same", () => {
        const any = setFacetMode(view({ tags: [SON, DAUGHTER] }), "performer", "any", kindOf);
        const one = cycleChip(cycleChip(any, DAUGHTER, "performer"), DAUGHTER, "performer");

        expect(one.groups).toEqual([]);
        expect(one.tags).toEqual([SON]);
        expect(facetMode(one, "performer")).toBe("all");
    });

    it("counts the facet's picks, the heart as one", () => {
        const picked = setFavorites(view({ tags: [SON, BEACH] }), "performer", "with");

        expect(withPicks(picked, "performer", kindOf)).toBe(2);
        expect(withPicks(picked, "tag", kindOf)).toBe(1);
    });
});

describe("the Favourites chip", () => {
    it("is a group of its own beside all-of picks: at least one favourite, and the picks", () => {
        const both = setFavorites(view({ tags: [DAUGHTER] }), "performer", "with");

        expect(favoritesOn(both, "performer")).toBe(true);
        expect(both.tags).toEqual([DAUGHTER]);
        expect(both.groups).toEqual([
            { match: "any", facet: "performer", rules: [{ t: "favTags", kind: "performer" }] },
        ]);
        // A heart alone is not "any of" mode: there is nothing to be any of yet.
        expect(facetMode(both, "performer")).toBe("all");
    });

    it("is one more alternative under any of", () => {
        const any = setFacetMode(
            setFavorites(view({ tags: [DAUGHTER, SON] }), "performer", "with"),
            "performer",
            "any",
            kindOf
        );

        expect(any.groups[0]?.rules).toEqual([
            { t: "favTags", kind: "performer" },
            { t: "tag", id: DAUGHTER },
            { t: "tag", id: SON },
        ]);

        const off = setFavorites(any, "performer", "off");

        expect(favoritesOn(off, "performer")).toBe(false);
        expect(facetMode(off, "performer")).toBe("any");
    });
});

describe("the Favourites chip's three states", () => {
    it("goes off, with, without, off, and is only ever in one place", () => {
        const on = cycleFavorites(view({ tags: [SON] }), "performer");

        expect(favoritesState(on, "performer")).toBe("with");

        const without = cycleFavorites(on, "performer");

        expect(favoritesState(without, "performer")).toBe("without");
        expect(without.tags).toEqual([SON]);
        expect(without.groups).toEqual([
            { match: "none", facet: "performer", rules: [{ t: "favTags", kind: "performer" }] },
        ]);

        const off = cycleFavorites(without, "performer");

        expect(favoritesState(off, "performer")).toBe("off");
        expect(off.groups).toEqual([]);
    });

    it("leaves the facet's any-of picks alone when excluded", () => {
        const any = setFacetMode(view({ tags: [SON, DAUGHTER] }), "performer", "any", kindOf);
        const without = setFavorites(any, "performer", "without");

        expect(facetMode(without, "performer")).toBe("any");
        expect(without.groups).toHaveLength(2);
        expect(normalizeTagLogic(without)).toEqual(without);
    });

    it("reads as without in the chips above the grid", () => {
        const names = { tag: () => undefined, root: () => undefined };

        expect(
            activeFilters(setFavorites(view(), "performer", "without"), names).map(
                (filter) => filter.label
            )
        ).toEqual(["Without my favourite performers"]);
    });
});

describe("the None chip", () => {
    const names = { tag: () => undefined, root: () => undefined };
    const labels = (current: LibraryView) =>
        activeFilters(current, names).map((filter) => filter.label);

    it("goes off, some performer, nobody yet, off", () => {
        const some = cycleNone(view(), "performer", kindOf);

        expect(noneState(some, "performer")).toBe("without");
        expect(some.groups).toEqual([
            { match: "none", facet: "performer", rules: [{ t: "untagged", kind: "performer" }] },
        ]);
        expect(normalizeTagLogic(some)).toEqual(some);

        const nobody = cycleNone(some, "performer", kindOf);

        expect(noneState(nobody, "performer")).toBe("with");
        expect(nobody.groups).toEqual([
            { match: "any", facet: "performer", rules: [{ t: "untagged", kind: "performer" }] },
        ]);

        const off = cycleNone(nobody, "performer", kindOf);

        expect(noneState(off, "performer")).toBe("off");
        expect(off.groups).toEqual([]);
    });

    it("joins a lone pick as an alternative rather than requiring both", () => {
        const either = setNone(view({ tags: [SON, BEACH] }), "performer", "with", kindOf);

        expect(either.tags).toEqual([BEACH]);
        expect(facetMode(either, "performer")).toBe("any");
        expect(either.groups[0]?.rules).toEqual([
            { t: "tag", id: SON },
            { t: "untagged", kind: "performer" },
        ]);
        expect(withPicks(either, "performer", kindOf)).toBe(2);

        // A pick added afterwards is one more alternative, not a requirement.
        expect(chipState(cycleChip(either, DAUGHTER, "performer"), DAUGHTER)).toBe("with");
        expect(cycleChip(either, DAUGHTER, "performer").tags).toEqual([BEACH]);

        // And taking None away leaves the lone pick where it started.
        expect(setNone(either, "performer", "off", kindOf).tags).toEqual([BEACH, SON]);
    });

    it("is dropped by all of, which cannot match it beside anything else", () => {
        const either = setNone(view({ tags: [SON] }), "performer", "with", kindOf);
        const all = setFacetMode(either, "performer", "all", kindOf);

        expect(noneState(all, "performer")).toBe("off");
        expect(all.tags).toEqual([SON]);
        expect(all.groups).toEqual([]);
    });

    it("shares the without group with the ♥, each leaving the other alone", () => {
        const both = setNone(
            setFavorites(view(), "performer", "without"),
            "performer",
            "without",
            kindOf
        );

        expect(both.groups).toEqual([
            {
                match: "none",
                facet: "performer",
                rules: [
                    { t: "favTags", kind: "performer" },
                    { t: "untagged", kind: "performer" },
                ],
            },
        ]);

        const heartOff = setFavorites(both, "performer", "off");

        expect(noneState(heartOff, "performer")).toBe("without");
        expect(favoritesState(heartOff, "performer")).toBe("off");
    });

    it("reads in words in the chips above the grid", () => {
        expect(labels(setNone(view(), "performer", "with", kindOf))).toEqual(["No performer yet"]);
        expect(labels(setNone(view(), "performer", "without", kindOf))).toEqual([
            "With any performer",
        ]);
    });

    /**
     * Beside the ♥ it is an alternative, and says so: "Any of my favourite performers, no
     * performer yet" read as "any favourite" followed by a second condition.
     */
    it("reads as an alternative beside the heart, and its without as a positive", () => {
        const either = setFavorites(
            setNone(view(), "performer", "with", kindOf),
            "performer",
            "with"
        );

        expect(labels(either)).toEqual(["My favourite performers or no performer yet"]);

        const neither = setFavorites(
            setNone(view(), "performer", "without", kindOf),
            "performer",
            "without"
        );

        expect(labels(neither)).toEqual(["Without my favourite performers and with any performer"]);
    });

    it("survives the address", () => {
        const built = setNone(view({ tags: [SON] }), "performer", "with", kindOf);

        expect(parseView(viewToParams(built))).toEqual(built);
    });
});

describe("the Advanced editor's groups", () => {
    it("are never touched by the panel", () => {
        const advanced = withAdvancedGroups(view(), [
            { match: "none", rules: [{ t: "tag", id: SON }] },
        ]);
        const after = setChip(
            setFacetMode(cycleChip(advanced, SON, "performer"), "performer", "any", kindOf),
            SON,
            "performer",
            "off"
        );

        expect(advancedGroups(after)).toEqual([{ match: "none", rules: [{ t: "tag", id: SON }] }]);
    });

    it("keep the panel's groups where they were when replaced", () => {
        const panel = setFavorites(view(), "performer", "with");
        const replaced = withAdvancedGroups(panel, [{ match: "any", rules: [{ t: "unrated" }] }]);

        expect(replaced.groups).toHaveLength(2);
        expect(replaced.groups[0]?.facet).toBe("performer");
    });
});

describe("normalising", () => {
    it("collapses a facet's lone pick, drops an empty group and leaves Advanced ones alone", () => {
        const normal = normalizeTagLogic(
            view({
                groups: [
                    { match: "any", facet: "performer", rules: [{ t: "tag", id: SON }] },
                    { match: "any", facet: "tag", rules: [] as never },
                    { match: "any", rules: [{ t: "tag", id: AUNT }] },
                ],
            })
        );

        expect(normal.tags).toEqual([SON]);
        expect(normal.groups).toEqual([{ match: "any", rules: [{ t: "tag", id: AUNT }] }]);
    });
});

describe("in the address and in a saved filter", () => {
    const built = withAdvancedGroups(
        setFacetMode(
            setFavorites(view({ tags: [SON, DAUGHTER], notTags: [AUNT] }), "performer", "with"),
            "performer",
            "any",
            kindOf
        ),
        [
            {
                match: "any",
                rules: [
                    { t: "unrated" },
                    { t: "rating", max: 2 },
                    { t: "measure", measure: "resolution", min: 2160 },
                ],
            },
        ]
    );

    it("survives the address", () => {
        expect(parseView(viewToParams(built))).toEqual(built);
    });

    it("survives being saved and opened", () => {
        const saved = viewToSavedQuery(built);

        expect(saved.groups).toEqual(built.groups);
        expect(saved.notTags).toEqual([AUNT]);
        expect(matchesSavedQuery(built, saved)).toBe(true);
        expect(parseView(savedQueryToParams(saved)).groups).toEqual(built.groups);
    });

    it("counts as an edit when a group changes", () => {
        const saved = viewToSavedQuery(built);
        const edited = setFavorites(built, "performer", "off");

        expect(matchesSavedQuery(edited, saved)).toBe(false);
    });

    it("still reads a filter saved before any of this existed", () => {
        expect(
            savedQuerySchema.safeParse({ tags: [SON], favorite: true, sort: "addedAt" }).success
        ).toBe(true);
    });

    it("drops a broken group from a hand-edited address rather than half of it", () => {
        const broken = parseView(
            new URLSearchParams("groups=%5B%7B%22match%22%3A%22maybe%22%7D%5D&tags=son")
        );

        expect(broken.groups).toEqual([]);
        expect(broken.tags).toEqual([SON]);
    });
});

describe("the chips above the grid", () => {
    it("say each clause in words, by name", () => {
        const names = {
            tag: (id: string) => ({ son: "Son", daughter: "Daughter", aunt: "Aunt" })[id],
            root: () => undefined,
        };
        const any = setFacetMode(
            view({ tags: [SON, DAUGHTER], notTags: [AUNT] }),
            "performer",
            "any",
            kindOf
        );

        expect(activeFilters(any, names).map((filter) => filter.label)).toEqual([
            "Without Aunt",
            "Son or Daughter",
        ]);
        expect(
            activeFilters(setFavorites(view({ tags: [SON] }), "performer", "with"), names).map(
                (filter) => filter.label
            )
        ).toEqual(["With Son", "My favourite performers"]);
    });
});
