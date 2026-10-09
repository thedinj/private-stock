import { NextResponse } from "next/server";

import { mediaQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { prepareLook } from "@/lib/services/lookService";
import { listMediaIdsPage } from "@/lib/services/mediaService";
import { overlayForRequest } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One page of the library as ids alone (§14b, §20).
 *
 * `/api/media` asked the same question with every tile hydrated, and the viewer — which only
 * needs to know what comes next — asked it again on every step. The parameters are the
 * listing's, parsed by the same schema and resolved against the same overlay, so the ids are
 * that page's ids in that page's order.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { filter, ...params } = Object.fromEntries(new URL(request.url).searchParams);
        const query = mediaQuerySchema.parse(params);

        // A look's words become a vector in another process; everything after this is
        // synchronous and reads the look this left ready (§5e "Search runs in two passes").
        await prepareLook(query, auth);

        // Resolved exactly as the page would be, or the order is a different set's (§6).
        return NextResponse.json(
            listMediaIdsPage(query, auth, overlayForRequest(filter ?? null, query, auth), true)
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
