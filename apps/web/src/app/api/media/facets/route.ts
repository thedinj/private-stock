import { NextResponse } from "next/server";

import { mediaQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { overlayForRequest } from "@/lib/services/savedFilterService";
import { getFacets } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Tag counts for the filter currently applied to the grid (§5c).
 *
 * Takes the same query the grid does, so the panel and the results cannot disagree about what
 * is being counted. Separate from the list response because the two have different lifetimes:
 * paging changes the rows but not the facets, and recomputing counts on every page of an
 * infinite scroll is exactly the wasted work a NAS cannot afford.
 */
/**
 * Facets the caller wants in full, as a comma-separated list of kinds.
 *
 * Its own parameter rather than part of `MediaQuery`, and deliberately: expanding a facet is
 * a fact about the panel, not about the library being described. In the query it would ride
 * into every saved filter, every shared link and the grid's own cache key — so opening a list
 * would look like a different search.
 *
 * Unknown names cost nothing: a kind that no facet has simply expands nothing.
 */
const expandedKinds = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean)
        .slice(0, 20);

/**
 * Narrows the expanded facet by name, for the box in the modal.
 *
 * Its own parameter for the same reason `expand` is: it describes the panel rather than the
 * library, and in `MediaQuery` it would ride into every saved filter and the grid's own cache
 * key. Trimmed and bounded here because it reaches a `LIKE`, and an unbounded one is a slow
 * query somebody can ask for repeatedly.
 */
const facetSearch = (value: string | undefined): string | undefined => {
    const trimmed = (value ?? "").trim().slice(0, 200);

    return trimmed.length > 0 ? trimmed : undefined;
};

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { expand, find, filter, ...params } = Object.fromEntries(
            new URL(request.url).searchParams
        );
        const query = mediaQuerySchema.parse(params);

        return NextResponse.json(
            getFacets(
                query,
                auth,
                undefined,
                expandedKinds(expand),
                facetSearch(find),
                // Counted against the same ratings as the grid beside it (§6).
                overlayForRequest(filter ?? null, query, auth)
            )
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
