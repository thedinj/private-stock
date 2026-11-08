import { NextResponse } from "next/server";

import { setReviewMarkSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setItemMark } from "@/lib/services/reviewPassService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Mark this item reviewed for one of your passes, or take the mark off (§14d "Reviewing
 * recordings for a reel"). Answers with the passes the item has now been through.
 *
 * No ChangeLog row, for the reason a rating has none: it is one viewer's private state (§13b).
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = setReviewMarkSchema.parse(await request.json());

        return NextResponse.json({ reviews: setItemMark(id, body, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
