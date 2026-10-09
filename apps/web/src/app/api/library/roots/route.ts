import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { librarySummaries } from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The libraries this viewer can see, each with its size and a face (§14), and the total the nav
 * shows beside "Library".
 *
 * The expensive half of the library summary: the counts walk an index entry per item. So it is
 * answered from a per-viewer cache, and the browser asks again when the change feed says items
 * came or went rather than on a short timer — see `librarySummaries` (§20).
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(librarySummaries(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
