import { reelsExportPreviewQuerySchema } from "@private-stock/core";
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { previewReelsExport } from "@/lib/services/reelExportService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** What exporting these reels to Resolve will produce, before anything is downloaded (§14d). */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { ids } = reelsExportPreviewQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(previewReelsExport(ids, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
