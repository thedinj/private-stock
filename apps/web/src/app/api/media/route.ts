import { NextResponse } from "next/server";

import { mediaQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { prepareLook } from "@/lib/services/lookService";
import { listMedia } from "@/lib/services/mediaService";
import { overlayForRequest } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { filter, ...params } = Object.fromEntries(new URL(request.url).searchParams);
        const query = mediaQuerySchema.parse(params);

        // A look's words become a vector in another process; everything after this is
        // synchronous and reads the look this left ready (§5e "Search runs in two passes").
        await prepareLook(query, auth);

        // `filter` names the saved filter the view was opened from, so a shared one resolves
        // against its owner's ratings here exactly as it does on a home shelf (§6).
        return NextResponse.json(
            listMedia(query, auth, overlayForRequest(filter ?? null, query, auth), true)
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
