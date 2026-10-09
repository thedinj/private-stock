import { NextResponse } from "next/server";

import { dupeQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listDupes, requestRescan } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Duplicate groups awaiting review. Admin only — see the service for why. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);
        const query = dupeQuerySchema.parse(params);

        return NextResponse.json(listDupes(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Queues a fresh clustering pass.
 *
 * A POST with no body rather than a GET side effect: it schedules real work, and a browser
 * prefetching links must not be able to start it.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);

        requestRescan(auth);

        return NextResponse.json({ queued: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
