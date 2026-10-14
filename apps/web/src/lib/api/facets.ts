"use client";

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { tagIdsInGroups, type FacetsResponse, type TagNamesResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { useLibraries } from "@/lib/api/libraries";
import { queryKeys } from "@/lib/api/queryKeys";
import type { FilterNames } from "@/lib/filterWords";
import type { LibraryView } from "@/lib/libraryQuery";

/**
 * Every tag id the view's filter uses as a control -- with, without, or inside a group --
 * sorted, so the same selection in another order is the same cache entry.
 */
const selectedTagIds = (view: LibraryView): string[] =>
    [...new Set([...view.tags, ...view.notTags, ...tagIdsInGroups(view.groups)])].sort();

/**
 * The query string the panel's tags are asked with, which is only the filter's tag ids: the
 * numbers are library-wide (§20 "Facets without counts"). `FacetModal` adds its own facet and
 * search to it.
 */
export const facetParams = (view: LibraryView): string => {
    const ids = selectedTagIds(view);

    return ids.length > 0 ? `selected=${ids.join(",")}` : "";
};

/**
 * The filter panel's tags for a view (§5c, §14e).
 *
 * A sort, a search or any filter but a tag asks nothing new: the key is the tag ids alone. On
 * the server the vocabulary behind it is held for a minute, so a new key is cheap too.
 */
export const useLibraryFacets = (view: LibraryView) => {
    const params = facetParams(view);

    return useQuery({
        queryKey: queryKeys.media.facetsFor(params),
        queryFn: () => api<FacetsResponse>(`/api/media/facets?${params}`),
        // Tagging invalidates this key; nothing else changes the answer within a visit.
        staleTime: 5 * 60_000,
        // The last answer stays up while a new selection is asked about. The panel draws only
        // the sections with something in them, so without this a tag chip clicked emptied the
        // column and refilled it a moment later.
        placeholderData: keepPreviousData,
    });
};

/**
 * What the view's filter names its tags, for the chips above the grid, the panel's sections
 * and the Advanced editor (§14e).
 *
 * Its own request, apart from the facets, and keyed by the ids alone: the chips above the grid
 * were paying for the panel's counts on every filter change, even with the panel shut.
 * The tag the filter looks for mentions of is named too.
 */
export const useTagNames = (view: LibraryView) => {
    const ids = [...new Set([...selectedTagIds(view), ...(view.mentions ? [view.mentions] : [])])]
        .sort()
        .join(",");

    return useQuery({
        queryKey: queryKeys.tags.names(ids),
        queryFn: () => api<TagNamesResponse>(`/api/tags/names?ids=${ids}`),
        enabled: ids.length > 0,
        staleTime: 5 * 60_000,
        placeholderData: keepPreviousData,
    });
};

/**
 * How this view's filter names its tags and libraries, for anything describing it in words.
 *
 * While the names load, the previous filter's answer stands in, and it may not name a tag the
 * new filter has just added; `describeRule` says "an unavailable tag" for that moment, which
 * is the same thing it says for a tag that has gone.
 */
export const useFilterNames = (view: LibraryView): FilterNames => {
    const { data: names } = useTagNames(view);
    const { data: libraries } = useLibraries();

    return useMemo(
        () => ({
            tag: (tagId) => names?.referencedTags[tagId]?.name,
            root: (rootId) => libraries?.libraries.find((library) => library.id === rootId)?.label,
        }),
        [names, libraries]
    );
};
