import { reelsExportQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { exportReels } from "@/lib/services/reelExportService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Several reels as one FCPXML file, a timeline each (§14d "Editor export"):
 * `?ids=a,b,c&rate=30000/1001`. Downloaded from a blob, as the single-reel export is.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { ids, rate } = reelsExportQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );
        const { fileName, body } = exportReels(ids, rate, auth);
        const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");

        return new Response(body, {
            headers: {
                "Content-Type": "application/xml; charset=utf-8",
                "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
