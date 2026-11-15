import { reelExportQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { exportReelMarkers } from "@/lib/services/reelExportService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One reel's labels, tags and rating as a markers EDL (§14d "Editor export"): `?rate=` must be
 * the rate its timeline was downloaded at, so each marker lands on its cut.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { rate } = reelExportQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );
        const { fileName, body } = exportReelMarkers(id, rate, auth);
        const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");

        return new Response(body, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
