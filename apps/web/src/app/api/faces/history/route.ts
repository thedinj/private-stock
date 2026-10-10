import { NextResponse } from "next/server";

import { faceHistoryQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { faceHistory } from "@/lib/services/faceHistoryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** History (§5f "Decisions you can take back"): face decisions, newest first, a page at a time. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = faceHistoryQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(faceHistory(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
