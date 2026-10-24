import { NextResponse } from "next/server";
import { z } from "zod";

import { faceSearchNameSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { faceSearchMatches, nameFromSearch } from "@/lib/services/faceSearchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const indexSchema = z.coerce.number().int().min(0).max(64);

/** The items whose faces are most like one face on the frame (§5f), best first. */
export async function GET(
    request: Request,
    context: { params: Promise<{ id: string; index: string }> }
) {
    try {
        const auth = await requireAuth(request);
        const { id, index } = await context.params;

        return NextResponse.json(faceSearchMatches(id, indexSchema.parse(index), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Say who the face is: the video asked from and the candidates said to be them are tagged. */
export async function POST(
    request: Request,
    context: { params: Promise<{ id: string; index: string }> }
) {
    try {
        const auth = await requireAuth(request);
        const { id, index } = await context.params;
        const decision = faceSearchNameSchema.parse(await request.json());

        return NextResponse.json(nameFromSearch(id, indexSchema.parse(index), decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
