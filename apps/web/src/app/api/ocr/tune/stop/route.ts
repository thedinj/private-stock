import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { stopTune } from "@/lib/services/ocrTuneService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Stop the tuning run; what it read stays cached for the next. Admin only. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(stopTune(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
