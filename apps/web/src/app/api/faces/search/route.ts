import { NextResponse } from "next/server";

import { faceSearchStartSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { startFaceSearch } from "@/lib/services/faceSearchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Who is this? (§5f): search the library's faces from a video's frame at a moment. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const input = faceSearchStartSchema.parse(await request.json());

        return NextResponse.json(startFaceSearch(input, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
