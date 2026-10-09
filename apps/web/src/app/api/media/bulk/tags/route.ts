import { NextResponse } from "next/server";

import { selectionTagsInputSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listSelectionTags } from "@/lib/services/tagService";

// Declared literally in every route — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * What a ticked selection carries (§14b).
 *
 * The read the untag dialogue is built on, so that taking a tag off a selection is a choice
 * from a list rather than a name typed from memory. Nothing else answers it: `/api/media/facets`
 * counts a filter, and a selection is a list of ids somebody ticked.
 *
 * **POST for a read**, for the reason `/api/tags/bulk`'s preview is: a selection runs to
 * `BULK_ACTION_LIMIT` ids and that does not fit in a query string. Nothing is written, and
 * nothing is cached either way — every route here is already `force-dynamic`.
 *
 * Under `/api/media/bulk/` rather than in the tag namespace because the subject is the
 * selection. `/api/tags/*` is the vocabulary's — kinds, ids, merges, scope — and a question
 * about a set of media filed there would sit apart from the endpoint that answers it.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { mediaIds } = selectionTagsInputSchema.parse(await request.json());

        return NextResponse.json(listSelectionTags(mediaIds, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
