import { NextResponse } from "next/server";

import { dupeReviewSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setReviewed } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Marks duplicate groups reviewed, or reopens them. Admin only; touches no file (§10c).
 *
 * One group or a page of them: a row's own button sends one id, and the triage sheet sends the
 * groups a reviewer left unticked after resolving the rest.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = dupeReviewSchema.parse(await request.json());

        return NextResponse.json({ updated: setReviewed(body.groupIds, body.reviewed, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
