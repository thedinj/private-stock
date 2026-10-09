import { NextResponse } from "next/server";

import { itemSuspectDecisionSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideItemSuspect, itemSuspects } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** "Maybe in this item" (§5f): performers it does not carry whose face or name it shows. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(itemSuspects(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** "Add" one of them, or "Not them". */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const decision = itemSuspectDecisionSchema.parse(await request.json());

        return NextResponse.json(decideItemSuspect(id, decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
