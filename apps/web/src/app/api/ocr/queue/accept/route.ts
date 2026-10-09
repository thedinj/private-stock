import { NextResponse } from "next/server";

import { ocrQueueAcceptSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { acceptOnItem } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Accept pairs from one item: tag every item showing their strings, and keep tagging new ones. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrQueueAcceptSchema.parse(await request.json());

        return NextResponse.json(acceptOnItem(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
