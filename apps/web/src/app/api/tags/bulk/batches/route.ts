import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listTagBatches } from "@/lib/services/bulkTagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** This account's recent bulk tagging, including batches already withdrawn. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ batches: listTagBatches(auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
