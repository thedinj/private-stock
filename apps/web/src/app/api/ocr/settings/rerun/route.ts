import { NextResponse } from "next/server";

import { ocrRerunOutdatedSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { rerunOutdated } from "@/lib/services/ocrSettingsService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Queue one batch of items read under older settings, as background work. Admin only. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrRerunOutdatedSchema.parse(await request.json());

        return NextResponse.json(rerunOutdated(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
