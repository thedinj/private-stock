import { NextResponse } from "next/server";

import { bulkTagApplySchema, bulkTagPreviewSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { applyBulkTag, previewBulkTag } from "@/lib/services/bulkTagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * How many items a filter would tag.
 *
 * A POST because the filter can be larger than a URL, and because asking is not a read of a
 * resource — it is a question about a hypothetical write.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = bulkTagPreviewSchema.parse(await request.json());

        return NextResponse.json(previewBulkTag(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Tags everything the filter matches, minus the exclusions.
 *
 * Refuses if the count has changed since the preview: the person agreed to a number, and the
 * library is allowed to move underneath them (§5d).
 */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = bulkTagApplySchema.parse(await request.json());

        return NextResponse.json(applyBulkTag(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
