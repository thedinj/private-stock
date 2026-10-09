import { NextResponse } from "next/server";

import { failedJobQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listFailedJobs } from "@/lib/services/jobService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Failures that still stand, newest first, a page at a time (§13c). Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(listFailedJobs(failedJobQuerySchema.parse(params), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
