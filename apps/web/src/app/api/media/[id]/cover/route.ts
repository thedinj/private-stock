import { NextResponse } from "next/server";

import { setCoverSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setCover } from "@/lib/services/frameService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Choose which frame represents this item, or revert to the generated one.
 *
 * A one-row update that overwrites no file, which is what makes reverting free: the
 * generated cover is still exactly where it was, and `null` points back at it (§13).
 *
 * Library-wide rather than per-viewer. Picking the frame that represents a video is curation
 * of the library, not a private preference — if it were per-user, two people would see
 * different grids and neither could fix the other's (§13).
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = setCoverSchema.parse(await request.json());

        return NextResponse.json({ frames: setCover(id, body.artifactId, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
