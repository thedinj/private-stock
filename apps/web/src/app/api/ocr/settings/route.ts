import { NextResponse } from "next/server";

import { ocrSettingsSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getOcrSettings, saveOcrSettings } from "@/lib/services/ocrSettingsService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** How OCR reads, and how much of the library predates the current settings. Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(getOcrSettings(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Save the settings. Applies to jobs that start afterwards; nothing is re-read. */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrSettingsSchema.parse(await request.json());

        return NextResponse.json(saveOcrSettings(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
