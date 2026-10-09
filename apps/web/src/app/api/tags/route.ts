import { NextResponse } from "next/server";
import { z } from "zod";

import { createTagSchema, tagScopeSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createTag, listFacetKinds, listTags, searchTags } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const listQuerySchema = z.object({
    /** Omit to get the list of facets instead of one facet's tags. */
    kind: z.string().trim().min(1).max(40).optional(),
    /**
     * Which vocabulary to list (§6).
     *
     * Defaulted here, unlike every *write*, and the asymmetry is deliberate: a default on a
     * read shows the wrong list, a default on a write publishes the wrong thing. Public is the
     * right default for a reader that did not say, because it is the one anybody can see.
     */
    scope: tagScopeSchema.default("public"),
    limit: z.coerce.number().int().min(1).max(2_000).default(500),
    /**
     * What somebody is typing into a tag box (§5b "One rule for names"). With it, the facet's
     * whole vocabulary is searched by the server's rule and ordered by how well each name
     * matches, rather than the most-used names sent for the browser to filter.
     */
    q: z.string().trim().min(1).max(200).optional(),
});

/**
 * The tag vocabulary.
 *
 * With a `kind`, one facet's tags and their counts — what an autocomplete needs. Without it,
 * just the facet names, which is what the filter panel needs to build itself before it knows
 * what to ask for.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        const params = Object.fromEntries(new URL(request.url).searchParams);
        const query = listQuerySchema.parse(params);

        if (!query.kind) {
            return NextResponse.json({ kinds: listFacetKinds(auth) });
        }

        if (query.q) {
            return NextResponse.json(
                searchTags(query.kind, query.scope, query.q, auth, Math.min(query.limit, 50))
            );
        }

        return NextResponse.json({ tags: listTags(query.kind, query.scope, auth, query.limit) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Creates a tag with no assignments.
 *
 * Any signed-in user, because tagging an item already creates tags implicitly — gating this
 * while leaving that open would be a rule that stops nothing. The separate endpoint exists so
 * a facet can be seeded before anything is tagged with it.
 *
 * *Which* vocabulary it lands in is the service's call: an administrator's goes into the
 * library's, anybody else's is their own (§6).
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);

        const body = createTagSchema.parse(await request.json());

        return NextResponse.json(createTag(body, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
