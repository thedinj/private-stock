import { NextResponse } from "next/server";

import { ocrMatchDecideSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { undo } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Take back an accept or a rejection. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrMatchDecideSchema.parse(await request.json());

        return NextResponse.json(undo(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
