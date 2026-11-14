import { reelExportQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { exportReel } from "@/lib/services/reelExportService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The reel as an FCPXML timeline, downloaded (§14d "Editor export").
 *
 * Fetched with the bearer token and saved from a blob, not linked: a plain link cannot carry
 * the header, and a signed URL would be a second way into a reel to reason about.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { rate } = reelExportQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );
        const { fileName, body } = exportReel(id, rate, auth);
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
