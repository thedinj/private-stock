import { NextResponse } from "next/server";

import { bulkClipTagSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { bulkTagClips } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Tags a selection of your clips as one batch, withdrawn through the same
 * `DELETE /api/tags/bulk/batches/[id]` as a batch of items (§5d).
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = bulkClipTagSchema.parse(await request.json());

        return NextResponse.json(bulkTagClips(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
