import { NextResponse } from "next/server";

import { vocabularyQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listVocabulary } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One tagging system's whole vocabulary, paged (§6).
 *
 * Separate from `GET /api/tags?kind=`, which answers a different question: that one feeds
 * autocomplete in a box that has already picked a facet, so it is one facet, count-ordered and
 * capped. This is the management screen — name- or count-ordered, searchable, paged, and able to ask for the tags nothing carries, which the count-ordered list puts last
 * and then truncates.
 *
 * Any signed-in user. The public vocabulary is readable by everybody — you cannot use a shared
 * vocabulary you cannot see — and `scope: "private"` resolves to the caller and can never
 * name anybody else.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(listVocabulary(vocabularyQuerySchema.parse(params), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
