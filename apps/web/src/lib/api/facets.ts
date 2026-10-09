"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { FacetsResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { useLibraries } from "@/lib/api/libraries";
import { queryKeys } from "@/lib/api/queryKeys";
import type { FilterNames } from "@/lib/filterWords";
import { viewToRequestParams, type LibraryView } from "@/lib/libraryQuery";

/**
 * The filter panel's facets for a view, and the names its filter's tags go by (§5c, §14e).
 *
 * One hook for the panel and the chips above the grid, so the two share a cache entry: the
 * chips need `referencedTags` to say "without Grandma" rather than an id, and asking for it
 * separately would be a second request for something the panel has already fetched.
 */
export const useLibraryFacets = (view: LibraryView) => {
    // Without the look (§5e): its few hundred are ranked in the web process, and the counts say
    // what each facet would match among the filters, which a look then orders.
    const requestParams = viewToRequestParams({ ...view, lookText: "", like: "" }).toString();

    return useQuery({
        queryKey: queryKeys.media.facetsFor(requestParams),
        queryFn: () => api<FacetsResponse>(`/api/media/facets?${requestParams}`),
        // Facets change only when the library or the filter does, and both already invalidate
        // this key. Without it, every remount of the drawer refetches counts that cannot have
        // changed — on mobile, that is every time it is opened.
        staleTime: 30_000,
        // The last answer stays up while the next is counted. The panel draws only the
        // sections with something in them, so without this every filter change emptied the
        // column and refilled it a moment later.
        placeholderData: (previous) => previous,
    });
};

/**
 * How this view's filter names its tags and libraries, for anything describing it in words.
 *
 * While the facets load, the previous filter's answer stands in, and it may not name a tag the
 * new filter has just added; `describeRule` says "an unavailable tag" for that moment, which
 * is the same thing it says for a tag that has gone.
 */
export const useFilterNames = (view: LibraryView): FilterNames => {
    const { data: facets } = useLibraryFacets(view);
    const { data: libraries } = useLibraries();

    return useMemo(
        () => ({
            tag: (tagId) => facets?.referencedTags[tagId]?.name,
            root: (rootId) => libraries?.libraries.find((library) => library.id === rootId)?.label,
        }),
        [facets, libraries]
    );
};
