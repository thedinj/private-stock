import { NextResponse } from "next/server";

import { setupRequestSchema } from "@private-stock/core";

import { readSmallJson, rejectCrossSite } from "@/lib/auth/requestGuards";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { completeSetup } from "@/lib/services/setupService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function POST(request: Request) {
    try {
        rejectCrossSite(request);

        const body = setupRequestSchema.parse(await readSmallJson(request));
        const user = await completeSetup(body, request);

        return NextResponse.json({ user }, { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
