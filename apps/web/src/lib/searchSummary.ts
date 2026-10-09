import { describeRange } from "@private-stock/core";

import { MEASURE_LABELS, describeGroup, describeRating, type FilterNames } from "./filterWords";
import {
    DEFAULT_VIEW,
    MEASURES,
    effectiveDirection,
    effectiveSort,
    type LibraryView,
} from "./libraryQuery";
import { DIRECTION_LABELS, SORT_LABELS } from "./sortWords";

/**
 * A library search in a few words, for the sidebar's "Last search" (§14b).
 *
 * **Not the chips.** The chips above the grid say what each filter is, because they sit beside
 * the panel that set it and each one has to be found and undone on its own. Here there is one
 * line under a nav entry, and its only job is recognition: is this the search I mean? So the
 * words that name a filter's axis go -- "With", "Size:", "Advanced:" -- because the value says
 * it: a performer's name is plainly a performer, "1–5 min" plainly a length.
 *
 * **One term and a count.** The first term is the one that best tells searches apart, and the
 * rest are counted rather than listed: "Alice +2" says there is more and how much, where a list
 * cut off at the sidebar's edge says neither. The order runs from what you typed or chose by
 * name -- a saved view, a look, a search, a tag -- to the broad strokes that most searches
 * share.
 *
 * **The library and the sort are not a search.** A library on its own already has its own row,
 * and the sort is said only when it is the one thing that differs: a reordering is what you
 * would recognise a view by only when nothing narrows it.
 */

/**
 * What names a search's tags and saved view, when they are known. `root` is there for the
 * groups, whose rules can name a library.
 */
export interface SummaryNames extends FilterNames {
    savedFilter: (filterId: string) => string | undefined;
}

/** The terms, best first. The root and the sort are not among them -- see `summarizeSearch`. */
const searchTerms = (view: LibraryView, names: SummaryNames): string[] => {
    // A tag the device has no name for is said as one, which is still a term to count.
    const tag = (id: string): string => names.tag(id) ?? "a tag";
    const terms: string[] = [];

    // A saved view is its query, so its name stands for everything it holds. Edited since it
    // was opened, it is still what you would call it.
    const saved = view.filterId ? names.savedFilter(view.filterId) : undefined;

    if (saved) return [saved];

    if (view.lookText) terms.push(`≈ “${view.lookText}”`);
    if (view.like) terms.push("More like this");
    if (view.search) terms.push(`“${view.search}”`);
    terms.push(...view.tags.map(tag));
    if (view.mentions) terms.push(`mentions ${tag(view.mentions)}`);
    terms.push(...view.notTags.map((id) => `not ${tag(id)}`));
    terms.push(...view.groups.map((group) => describeGroup(group, { ...names, tag })));
    if (view.favorite) terms.push("Favourites");
    if (view.unrated) terms.push("Unrated");
    if (view.watched) terms.push(view.watched === "yes" ? "Watched" : "Not watched");
    if (view.minRating !== null || view.maxRating !== null) {
        terms.push(describeRating(view.minRating, view.maxRating));
    }

    for (const measure of MEASURES) {
        const { bands, unit } = MEASURE_LABELS[measure];
        const described = describeRange(
            bands,
            view.measures[measure].min,
            view.measures[measure].max,
            unit
        );

        if (described) terms.push(described);
    }

    if (view.orientation) {
        terms.push(view.orientation.charAt(0).toUpperCase() + view.orientation.slice(1));
    }
    if (view.animated) terms.push(view.animated === "yes" ? "Animated" : "Stills");
    if (view.kind === "image") terms.push("Photos");
    if (view.kind === "all") terms.push("All items");

    return terms;
};

/** The sort in words, or null when it is the library's own. */
const sortTerm = (view: LibraryView): string | null => {
    const sort = effectiveSort(view);
    const direction = effectiveDirection(view);

    if (sort === DEFAULT_VIEW.sort && direction === effectiveDirection(DEFAULT_VIEW)) {
        return null;
    }
    if (sort === "random") return SORT_LABELS.random;

    return `${SORT_LABELS[sort]} · ${DIRECTION_LABELS[sort][direction === "asc" ? 0 : 1]}`;
};

/**
 * The line under "Last search", or null when the view is no search at all -- the library as it
 * opens, or one library as its own row opens it. Null is also what decides that a view is not
 * worth remembering (`rememberedPages.ts`), so the two cannot disagree.
 */
export const summarizeSearch = (view: LibraryView, names: SummaryNames): string | null => {
    const [first, ...rest] = searchTerms(view, names);

    if (first === undefined) {
        return sortTerm(view);
    }

    // Counted last, since it is where the search is rather than what it is for -- and only
    // here, because a library with nothing else is that library's own row.
    const more = rest.length + (view.root ? 1 : 0);

    return more > 0 ? `${first} +${more}` : first;
};

/** Names for nothing: what decides whether a view is a search at all, before names are known. */
export const NO_SUMMARY_NAMES: SummaryNames = {
    tag: () => undefined,
    root: () => undefined,
    savedFilter: () => undefined,
};
