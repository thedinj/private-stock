import { NextResponse } from "next/server";

import { ocrQueueSkipSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { skipOnItem } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Leave one item out of some pairs, which stay open for the rest. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrQueueSkipSchema.parse(await request.json());

        return NextResponse.json(skipOnItem(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
