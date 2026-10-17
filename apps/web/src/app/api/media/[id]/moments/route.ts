import { NextResponse } from "next/server";

import { faceMomentsQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { faceMoments } from "@/lib/services/faceMomentService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The frames a video's face at `?at=` may really be, and the one its sprite tile looks like
 * (§9 "What a tile shows"): for framing a picture from the face, and for going to it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const query = faceMomentsQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(await faceMoments(id, query.at, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
