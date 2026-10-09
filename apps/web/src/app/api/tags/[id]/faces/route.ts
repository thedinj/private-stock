import { NextResponse } from "next/server";

import { faceGroupDecisionSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideFaceGroup, performerFaces } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * "Their face" on a performer's page (§5f): the face groups that are, or might be, them. Its own
 * request, asked for once the section nears the viewport, as "Appears with" is.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(performerFaces(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** "That's them" or "Not them", said of one of those groups. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const decision = faceGroupDecisionSchema.parse(await request.json());

        return NextResponse.json(decideFaceGroup(id, decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
