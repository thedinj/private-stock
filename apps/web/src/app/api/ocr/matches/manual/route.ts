import { NextResponse } from "next/server";

import { ocrMatchManualSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { manual } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** File a string under a performer or source the matcher did not propose. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrMatchManualSchema.parse(await request.json());

        return NextResponse.json(manual(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
