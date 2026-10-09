import { NextResponse } from "next/server";

import { facePeekQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { facePeek } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** A closer look at one face in a review row: its item's other faces in the group (§5f). */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = facePeekQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(facePeek(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
