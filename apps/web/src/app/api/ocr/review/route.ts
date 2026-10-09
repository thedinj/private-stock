import { NextResponse } from "next/server";

import { ocrReviewSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { review } from "@/lib/services/ocrReviewService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Confirm, dismiss or restore findings, by id or by whole string. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrReviewSchema.parse(await request.json());

        return NextResponse.json(review(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
