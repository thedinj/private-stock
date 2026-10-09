import { NextResponse } from "next/server";

import { captureQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listCaptures } from "@/lib/services/frameService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The Captures page: **this viewer's own stills**, searched and paged (§9).
 *
 * Captures are library-wide to read, but this lists only your own; everybody's remain on each
 * item's strip.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = captureQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(listCaptures(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
