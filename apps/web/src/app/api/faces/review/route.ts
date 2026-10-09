import { NextResponse } from "next/server";

import { faceReviewDecisionSchema, faceReviewQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideFaceReview, reviewFaces } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Review › Faces (§5f): a page of Matches or Unnamed, one face group a row. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = faceReviewQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(reviewFaces(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Answer a row: tag its items as the performer, say it is not them, or name who it is. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const decision = faceReviewDecisionSchema.parse(await request.json());

        return NextResponse.json(decideFaceReview(decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
