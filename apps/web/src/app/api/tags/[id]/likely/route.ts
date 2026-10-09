import { NextResponse } from "next/server";

import { likelyDecisionSchema, likelyQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideLikely, likely } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * "Likely" on a performer's page (§5f): the items that are probably them and do not carry them
 * yet, a page at a time, with the evidence for each.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const query = likelyQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(likely(id, query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Tag some of them with the performer, as one batch that can be undone; or "Not them". */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const decision = likelyDecisionSchema.parse(await request.json());

        return NextResponse.json(decideLikely(id, decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
