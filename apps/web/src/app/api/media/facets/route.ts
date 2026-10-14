import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getFacets } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The filter panel's tags, each with how many items carry it across the library (§5c, §20
 * "Facets without counts").
 *
 * Not the grid's query: the numbers are library-wide, so the filter would only split the cache.
 * What it takes from the filter is the tag ids it names (`selected`), which are drawn first and
 * even past the cap, being the controls that undo it.
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

/** The filter's tag ids, as a comma-separated list. Bounded like any list in an address. */
const selectedIds = (value: string | undefined): string[] =>
    (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 200);

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { selected, expand, find } = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(
            await getFacets(
                selectedIds(selected),
                auth,
                undefined,
                expandedKinds(expand),
                facetSearch(find)
            )
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
