import { NextResponse } from "next/server";

import { mediaLookupQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { lookupMedia } from "@/lib/services/mediaService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The items the grid is showing, as they stand now (§13b).
 *
 * For a grid that keeps its order while the library changes: it asks about what is on
 * screen rather than refetching the page, patches what came back and drops what did not.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { ids } = mediaLookupQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(lookupMedia(ids, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
