import { domainProfiles, type FacetLabel } from "@private-stock/core";

import { getActiveDomain } from "./activeDomain";

/**
 * What a facet is called on screen (§5b).
 *
 * **`tag` is displayed as "Keyword".** The word "tag" is the umbrella — everything in both
 * systems is a tag — and it was also the name of the catch-all facet beside `performer` and
 * `source`, so every list of facets named one of its members after the whole set: a section
 * reading "Tags" whose first box also read "Tags". The umbrella keeps the word, because it is
 * the word everybody already uses for the concept; the catch-all gets a narrower one.
 *
 * A display label and nothing more. `Tag.kind` still stores `"tag"`, so no row moves, no
 * query changes, and a facet the vocabulary retires still shows under its own stored name
 * (`kind` is an open string and a tag that cannot be seen is a tag nobody can remove).
 *
 * One table rather than the three that had grown up in the filter panel, the item editor and
 * the vocabulary screen: they had drifted already — "Source" was plural in one and singular
 * in another — and a rename that reached two of three would be worse than no rename at all.
 *
 * **The table is the room's** (§21): a `performer` is a Person in the Parlour and a Player in
 * the Game Room, where a `source` is the Game. The room is fixed for the life of the page, so
 * reading it here rather than through a hook is safe.
 */

const labels = (): Record<string, FacetLabel> => domainProfiles[getActiveDomain()].facets;

const capitalize = (kind: string): string => kind.charAt(0).toUpperCase() + kind.slice(1);

/** One of them: a column value, a chip, a facet picker's option. */
export const facetLabel = (kind: string): string => labels()[kind]?.one ?? capitalize(kind);

/** A heading over the set of them. */
export const facetLabelPlural = (kind: string): string => labels()[kind]?.many ?? capitalize(kind);
