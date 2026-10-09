import { NextResponse } from "next/server";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getProcessingStatus } from "@/lib/services/pipelineService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * How far the library has been processed (§13c).
 *
 * Separate from `/api/admin/scan` on purpose. That endpoint describes libraries and settings
 * and is loaded once; this one aggregates over a table with a row per item per stage and is
 * polled every couple of seconds while work runs. Behind one endpoint the expensive half
 * would run every time the cheap half was wanted.
 *
 * Polled rather than pushed down the SSE feed (§13b), which is per-user and filtered by
 * library access: these are whole-library totals, so putting them on that stream would either
 * leak the size of libraries a viewer cannot see or need a second filtering rule. Polling
 * also costs nothing when nobody has the page open, which is the normal case.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        return NextResponse.json(getProcessingStatus());
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
