import { NextResponse } from "next/server";

import { mediaTokensRequestSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { issueCastTokens } from "@/lib/services/mediaTokenService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Cast links for the next few items in a TV's queue (§11, continuous play).
 *
 * POST and header-only for the reasons `[id]/token` gives: it mints credentials. One request
 * for the batch rather than one per item, because a queue is topped up while the phone is
 * briefly awake, and that window is better spent on one round trip than eight.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { ids } = mediaTokensRequestSchema.parse(await request.json());

        return NextResponse.json(issueCastTokens(ids, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
