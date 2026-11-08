import { NextResponse } from "next/server";

import { clipQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listClipIds } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Every clip the browser's filter matches, as ids (§14d "Reviewing recordings for a reel").
 *
 * "Select all N matching": a reel cut by period is every keeper added in October, which runs to
 * more than a page. The same query as `GET /api/clips`, so the selection is exactly what the
 * filter shows; capped at one reel's worth, with the full count beside it.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = clipQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

        return NextResponse.json(listClipIds(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
