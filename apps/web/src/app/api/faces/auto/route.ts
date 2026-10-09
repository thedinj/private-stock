import { NextResponse } from "next/server";

import { autoTagDecisionSchema, autoTagQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { autoTagList, decideAutoTag } from "@/lib/services/autoTagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** "Would tag" (§5f): what the rule would tag by itself, a page at a time, with its counts. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = autoTagQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(autoTagList(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** "Right" or "Wrong", of one item the rule would tag. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const decision = autoTagDecisionSchema.parse(await request.json());

        return NextResponse.json(decideAutoTag(decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
