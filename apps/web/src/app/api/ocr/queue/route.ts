import { NextResponse } from "next/server";

import { ocrQueueQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listQueue } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Items whose text names a performer or source nobody has decided about, newest first. Admin only — see the service for why. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(listQueue(ocrQueueQuerySchema.parse(params), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
