import { NextResponse } from "next/server";

import type { SavedFilterCovers } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { savedFilterCovers } from "@/lib/services/viewCoverService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * A saved view's face, for its card (§14c).
 *
 * One view per request rather than a batch: the card asks when it comes on screen, so a page
 * of eighty views costs the dozen somebody can see rather than all eighty.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body: SavedFilterCovers = { covers: savedFilterCovers(id, auth) };

        return NextResponse.json(body);
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
