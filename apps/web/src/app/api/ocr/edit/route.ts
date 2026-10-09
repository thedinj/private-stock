import { NextResponse } from "next/server";

import { ocrEditSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { edit } from "@/lib/services/ocrReviewService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Correct the text of findings, by id or by whole string. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrEditSchema.parse(await request.json());

        return NextResponse.json(edit(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
