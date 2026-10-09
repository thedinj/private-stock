import { NextResponse } from "next/server";

import { mediaQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { prepareLook } from "@/lib/services/lookService";
import { countMedia } from "@/lib/services/mediaService";
import { overlayForRequest } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * How many items match the current filter, and how many pages that is (§20).
 *
 * Separate from the page itself because the two have completely different costs and
 * lifetimes. A page is an indexed walk of sixty rows; a count is a scan of the entire
 * matching set — 188 ms against 0.4 ms at 200k items. And the answer only changes when the
 * *filter* changes, which it does not while someone pages through it.
 *
 * So the client caches this against the filter and never refetches it on a page turn. The
 * alternative — returning `total` with every page, as the first version did — made every
 * page turn pay for a number that had not changed.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { filter, ...params } = Object.fromEntries(new URL(request.url).searchParams);
        const query = mediaQuerySchema.parse(params);

        // A look's words become a vector in another process; everything after this is
        // synchronous and reads the look this left ready (§5e "Search runs in two passes").
        await prepareLook(query, auth);

        // Resolved exactly as the page was, or the count describes a different set (§6).
        return NextResponse.json(
            countMedia(query, auth, overlayForRequest(filter ?? null, query, auth), true)
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
