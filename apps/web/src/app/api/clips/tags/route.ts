import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listClipTagFacets } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The chips for the browser's two tag fields: tags on your clips, and tags on their videos
 * (§14d "Tagging clips"). Counted over all your clips, so a chip holds its place.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(listClipTagFacets(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
