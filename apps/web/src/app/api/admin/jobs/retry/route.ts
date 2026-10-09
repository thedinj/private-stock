import { NextResponse } from "next/server";

import { retryFailedJobsSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { retryFailedJobs } from "@/lib/services/jobService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Tries failed work again (§13c): the chosen failures, or every standing one of a kind. Each
 * goes through the door its kind already has -- see `jobService`. Admin only.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(
            retryFailedJobs(retryFailedJobsSchema.parse(await request.json()), auth)
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
