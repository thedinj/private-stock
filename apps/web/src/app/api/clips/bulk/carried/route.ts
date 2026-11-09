import { NextResponse } from "next/server";

import { clipSelectionSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listClipSelectionTags } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * What a selection of your clips carries, for the untag dialogue (§14d "Tagging clips").
 *
 * POST for a read, as `/api/media/bulk/tags` is: five hundred ids do not fit in a query string.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = clipSelectionSchema.parse(await request.json());

        return NextResponse.json(listClipSelectionTags(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
