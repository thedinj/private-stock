import { describe, expect, it } from "vitest";

import { buildFacets, type FacetValue } from "./facets";

/** A vocabulary value, carried by `n` items across the library. */
const count = (tagId: string, kind: string, name: string, n: number): FacetValue => ({
    tagId,
    kind,
    name,
    colorKey: null,
    uses: n,
});

const build = (
    values: FacetValue[],
    options: {
        selected?: FacetValue[];
        totals?: Record<string, number>;
        selectedTagIds?: string[];
        order?: string[];
        /** The per-facet cap. Effectively off unless a test is about the cap. */
        limitFor?: (kind: string) => number;
        scope?: "public" | "private";
    } = {}
) => {
    return buildFacets({
        values,
        selected: options.selected ?? [],
        totals: new Map(Object.entries(options.totals ?? {})),
        selectedTagIds: options.selectedTagIds ?? [],
        order: options.order ?? ["tag", "performer", "source"],
        limitFor: options.limitFor ?? (() => Number.MAX_SAFE_INTEGER),
        // Public unless a test says otherwise: `buildFacets` carries the scope through rather
        // than deciding anything with it, so it is a passenger in every case here (§6).
        scope: options.scope ?? "public",
    });
};

describe("buildFacets", () => {
    it("groups values by facet", () => {
        const facets = build([
            count("t1", "tag", "Drama", 5),
            count("t2", "tag", "Noir", 2),
            count("t3", "performer", "Jane Doe", 3),
        ]);

        expect(facets.map((facet) => facet.kind)).toEqual(["tag", "performer"]);
        expect(facets[0].values.map((value) => value.name)).toEqual(["Drama", "Noir"]);
    });

    describe("truncated", () => {
        it("is false when every value is shown", () => {
            // The regression this file exists for. Reporting a fully visible facet as
            // truncated tells the user values are hidden when none are, and there is no
            // action they can take to see the ones that do not exist.
            const facets = build([count("t1", "tag", "Drama", 1)], {
                totals: { tag: 1 },
                selectedTagIds: ["t1"],
            });

            expect(facets[0].truncated).toBe(false);
        });

        it("is false when a selected value is the only one", () => {
            const facets = build([], {
                selected: [count("t1", "tag", "Drama", 1)],
                totals: { tag: 1 },
                selectedTagIds: ["t1"],
            });

            expect(facets[0].truncated).toBe(false);
        });

        it("is true when the facet has more values than were returned", () => {
            const facets = build([count("t1", "performer", "Jane Doe", 3)], {
                totals: { performer: 340 },
            });

            expect(facets[0].truncated).toBe(true);
        });

        it("counts a promoted selection as visible", () => {
            // 20 returned plus one selection promoted into view is 21 of 340 — still
            // truncated, but by one fewer than before the promotion.
            const counts = Array.from({ length: 20 }, (_, i) =>
                count(`t${i}`, "performer", `P${i}`, 5)
            );

            const facets = build(counts, {
                selected: [count("sel", "performer", "Selected", 1)],
                totals: { performer: 21 },
                selectedTagIds: ["sel"],
            });

            expect(facets[0].values).toHaveLength(21);
            expect(facets[0].truncated).toBe(false);
        });
    });

    describe("selected values", () => {
        it("appear even when the capped counts left them out", () => {
            // Otherwise the user is looking at a filtered library with no visible control to
            // unfilter it.
            const facets = build([count("t1", "tag", "Drama", 5)], {
                selected: [count("rare", "tag", "Rare", 1)],
                selectedTagIds: ["rare"],
            });

            expect(facets[0].values.map((value) => value.name)).toEqual(["Rare", "Drama"]);
        });

        it("are not duplicated when they were already in the counts", () => {
            const facets = build([count("t1", "tag", "Drama", 5)], {
                selected: [count("t1", "tag", "Drama", 5)],
                selectedTagIds: ["t1"],
            });

            expect(facets[0].values).toHaveLength(1);
        });

        it("sort first, so the undo control is never buried", () => {
            const facets = build(
                [count("big", "tag", "Popular", 100), count("small", "tag", "Niche", 1)],
                { selectedTagIds: ["small"] }
            );

            expect(facets[0].values.map((value) => value.name)).toEqual(["Niche", "Popular"]);
        });

        it("keeps a selection nothing carries any more, so it can still be undone", () => {
            const facets = build([], {
                selected: [count("t1", "tag", "Noir", 0)],
                selectedTagIds: ["t1"],
            });

            expect(facets[0].values[0]).toMatchObject({ name: "Noir", uses: 0 });
        });
    });

    describe("vocabulary order", () => {
        it("orders by library-wide use and shows that number", () => {
            const facets = build([
                count("niche", "tag", "Niche", 2),
                count("popular", "tag", "Popular", 100),
            ]);

            expect(facets[0].values.map((value) => [value.name, value.uses])).toEqual([
                ["Popular", 100],
                ["Niche", 2],
            ]);
        });
    });

    describe("facet ordering", () => {
        it("follows the display order", () => {
            const facets = build([
                count("t1", "source", "Aurora", 1),
                count("t2", "tag", "Drama", 1),
            ]);

            expect(facets.map((facet) => facet.kind)).toEqual(["tag", "source"]);
        });

        it("puts unknown facets last rather than first", () => {
            // indexOf returns -1 for an unknown kind, which sorts ahead of everything if it
            // is used directly — so a scraper inventing a facet would push a real facet down.
            const facets = build([
                count("t1", "director", "Someone", 1),
                count("t2", "tag", "Drama", 1),
            ]);

            expect(facets.map((facet) => facet.kind)).toEqual(["tag", "director"]);
        });
    });
});

/**
 * Showing the rest of a facet (§5c).
 *
 * The cap is what makes the panel usable -- a performer facet on a real library runs to
 * thousands -- and it is also what hides values somebody is looking for. Expanding raises
 * the cap for one facet, so the trim has to be per kind, and it has to happen after the sort
 * that promotes selections or a cap could drop the control that undoes the current filter.
 */
describe("expanding one facet", () => {
    const many = (kind: string, n: number) =>
        Array.from({ length: n }, (_, index) =>
            count(`${kind}${index}`, kind, `${kind} ${index}`, n - index)
        );

    it("caps each facet at its own limit", () => {
        const facets = build([...many("tag", 30), ...many("performer", 30)], {
            totals: { tag: 30, performer: 30 },
            limitFor: (kind) => (kind === "tag" ? 25 : 5),
        });

        expect(facets.find((facet) => facet.kind === "tag")?.values).toHaveLength(25);
        expect(facets.find((facet) => facet.kind === "performer")?.values).toHaveLength(5);
    });

    it("reports what is still hidden, and how many there are in total", () => {
        const [facet] = build(many("tag", 30), {
            totals: { tag: 340 },
            limitFor: () => 20,
        });

        expect(facet.values).toHaveLength(20);
        expect(facet.truncated).toBe(true);
        // What "show all" is offering. Without it the control asks somebody to agree to an
        // unknown amount of scrolling.
        expect(facet.total).toBe(340);
    });

    it("stops saying truncated once everything fits", () => {
        const [facet] = build(many("tag", 30), { totals: { tag: 30 }, limitFor: () => 500 });

        expect(facet.values).toHaveLength(30);
        expect(facet.truncated).toBe(false);
        expect(facet.total).toBe(30);
    });

    /**
     * A selected value can fall outside its own facet's top values once other filters narrow
     * things. If the cap dropped it, the user would be looking at a filtered library with no
     * visible control to unfilter it -- the failure the whole "selected" path exists for.
     */
    it("never trims away a selection, however low the cap", () => {
        const unpopular = count("rare", "tag", "Clown", 1);
        const [facet] = build([...many("tag", 30), unpopular], {
            selected: [unpopular],
            selectedTagIds: ["rare"],
            totals: { tag: 31 },
            limitFor: () => 1,
        });

        expect(facet.values.map((value) => value.tagId)).toContain("rare");
    });
});
