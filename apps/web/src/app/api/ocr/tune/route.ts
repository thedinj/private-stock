import { NextResponse } from "next/server";

import { tuneStartSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getTune, startTune } from "@/lib/services/ocrTuneService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** The latest tuning run, for its progress and results. Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(getTune(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Start a tuning run against the bench's expected text. Admin only. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = tuneStartSchema.parse(await request.json());

        return NextResponse.json(startTune(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
