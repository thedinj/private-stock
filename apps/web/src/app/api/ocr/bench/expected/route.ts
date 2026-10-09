import { NextResponse } from "next/server";

import { ocrExpectedInputSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setExpected } from "@/lib/services/ocrBenchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Say what a nominated video should yield, for tuning and for marking comparisons. Admin only. */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrExpectedInputSchema.parse(await request.json());

        return NextResponse.json(setExpected(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
