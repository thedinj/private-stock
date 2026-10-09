import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { removeReelItem } from "@/lib/services/reelService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Takes one entry out and closes the gap behind it.
 *
 * By `ReelItem.id` and not by clip id: a reel may hold the same span twice — a refrain is a
 * cut — so a clip id names either no row or an ambiguous pair.
 */
export async function DELETE(
    request: Request,
    context: { params: Promise<{ id: string; itemId: string }> }
) {
    try {
        const auth = await requireAuth(request);
        const { id, itemId } = await context.params;

        return NextResponse.json(removeReelItem(id, itemId, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
