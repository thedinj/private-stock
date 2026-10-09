import { NextResponse } from "next/server";

import { createClipSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createClip } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Marks a span of this item.
 *
 * POST only. The item's clips come back on its detail, exactly as its captured frames do — one
 * thing to refresh and one cache key, rather than a second request per page load for a list
 * that is usually empty.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = createClipSchema.parse(await request.json());

        return NextResponse.json(createClip(id, body, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
