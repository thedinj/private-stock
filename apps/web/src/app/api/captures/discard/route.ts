import { NextResponse } from "next/server";

import { discardCapturesSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { discardCaptures } from "@/lib/services/frameService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Discard a selection of captures from the Captures page.
 *
 * POST rather than DELETE, as `api/media/bulk` is: the selection is the subject. Answers 200
 * with per-capture failures, because a selection held across pages can go stale in part and
 * no single status is true of all of it.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = discardCapturesSchema.parse(await request.json());

        return NextResponse.json(await discardCaptures(body.artifactIds, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
