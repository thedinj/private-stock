import { NextResponse } from "next/server";

import { ocrTestSetAddSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { addToTestSet } from "@/lib/services/ocrBenchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Nominate more videos for the bench. Admin only. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrTestSetAddSchema.parse(await request.json());

        return NextResponse.json(addToTestSet(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
