import type { Facet } from "@private-stock/core";

/**
 * Assembling the filter panel's facets from the vocabulary and the filter's selections (§5c, §20).
 *
 * Pure, and separate from the service, because the arithmetic here is the kind that looks
 * obviously right and is not. It reads plausibly in every case except the ones that matter,
 * and a running server is a poor place to discover which.
 *
 * Which values a facet has comes from the vocabulary, so the list is complete however large
 * the library grows. It used to be a `GROUP BY` over a sample of the filtered library, which
 * only appeared to answer the question -- a tag applied to one item was usually missing from
 * the panel altogether. Each value carries how many items it is on across the library; the
 * filter's own counts were dropped for what they cost (§20 "Facets without counts").
 */

export interface FacetValue {
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    /**
     * How many items carry this value across the library.
     *
     * The ordering key, and what the chip shows. It does not move with the filter, so a chip
     * stays in one place while unrelated filters change.
     */
    uses: number;
}

export interface BuildFacetsInput {
    /** The vocabulary's values per facet, ordered and capped by the query that read them. */
    values: FacetValue[];
    /**
     * Selected values that the vocabulary page did not include, uncapped.
     *
     * A selected value can sit outside its own facet's most-used few. If the chip then
     * vanished, the user would be looking at a filtered library with no visible control to
     * unfilter it.
     */
    selected: FacetValue[];
    /** Distinct values each facet's vocabulary holds, before the cap. */
    totals: Map<string, number>;
    selectedTagIds: string[];
    /** Facet display order. Anything not listed sorts after, alphabetically. */
    order: string[];
    /**
     * How many values each facet may show.
     *
     * Per kind rather than one number, because expanding is per facet: asking to see every
     * performer says nothing about wanting every tag, and raising the limit for all of them
     * would answer a question nobody asked with a slower page.
     */
    limitFor: (kind: string) => number;
    /**
     * Which system these values came from (§6).
     *
     * Carried through rather than derived, because a facet belongs to one system and the
     * panel renders the two as separate groups. Nothing here can tell them apart from the
     * rows alone -- a public "beach" and a private "beach" are two tag ids and two names.
     */
    scope: Facet["scope"];
}

export const buildFacets = (input: BuildFacetsInput): Facet[] => {
    const seen = new Set(input.values.map((row) => row.tagId));
    const merged = [...input.values, ...input.selected.filter((row) => !seen.has(row.tagId))];

    const byKind = new Map<string, Facet>();

    for (const row of merged) {
        let facet = byKind.get(row.kind);

        if (!facet) {
            facet = {
                kind: row.kind,
                scope: input.scope,
                values: [],
                truncated: false,
                total: 0,
                // Filled in by the service, which knows whose favourites and in which pass.
                favorites: null,
            };
            byKind.set(row.kind, facet);
        }

        facet.values.push({
            tagId: row.tagId,
            name: row.name,
            colorKey: row.colorKey,
            uses: row.uses,
        });
    }

    const isSelected = (tagId: string): boolean => input.selectedTagIds.includes(tagId);
    const usesOf = new Map(merged.map((row) => [row.tagId, row.uses]));

    for (const facet of byKind.values()) {
        // Selected first, so the controls that *undo* the current filter are never buried
        // under values that merely refine it -- and so the trim below can never drop one.
        facet.values.sort((a, b) => {
            const bySelection = Number(isSelected(b.tagId)) - Number(isSelected(a.tagId));

            return (
                bySelection ||
                (usesOf.get(b.tagId) ?? 0) - (usesOf.get(a.tagId) ?? 0) ||
                a.name.localeCompare(b.name)
            );
        });

        /**
         * Trimmed after sorting, which is the whole reason the order above matters.
         *
         * A selected value can sit outside its own facet's most-used few, and if the chip
         * vanished the user would be looking at a filtered library with no visible control to
         * unfilter it. Sorting selections to the front first makes them the last thing a cap
         * could reach.
         */
        facet.values = facet.values.slice(
            0,
            Math.max(input.limitFor(facet.kind), input.selectedTagIds.length)
        );

        facet.total = input.totals.get(facet.kind) ?? facet.values.length;

        /**
         * Truncated means "there are values you cannot see".
         *
         * Compared against everything shown, selections included — an earlier version
         * subtracted the selections first, on the theory that a promoted selection was not
         * evidence the rest of the facet was visible. That was wrong in the ordinary case: a
         * facet whose only value is the selected one shows all of itself, and reporting it as
         * truncated tells the user values are hidden when none are.
         */
        facet.truncated = facet.total > facet.values.length;
    }

    return [...byKind.values()].sort((a, b) => {
        const aIndex = input.order.indexOf(a.kind);
        const bIndex = input.order.indexOf(b.kind);

        // Unknown facets sort after known ones rather than jumping to the front, which is
        // what indexOf's -1 would otherwise do.
        return (
            (aIndex === -1 ? input.order.length : aIndex) -
                (bIndex === -1 ? input.order.length : bIndex) || a.kind.localeCompare(b.kind)
        );
    });
};
