import { NextResponse } from "next/server";

import { ocrTestSetInputSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getBench, setTestSet } from "@/lib/services/ocrBenchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** The nominated videos and their latest comparison. Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(getBench(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Replace the nominated videos. Admin only. */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrTestSetInputSchema.parse(await request.json());

        return NextResponse.json(setTestSet(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
