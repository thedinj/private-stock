import { NextResponse } from "next/server";

import { updateCaptureSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteCapture, renameCapture } from "@/lib/services/frameService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Delete a captured frame.
 *
 * Captures only. The generated cover and its alternates belong to the generator, and
 * removing one would simply invite it back on the next sweep. A capture that happened to be
 * the cover leaves the item on the generated one, which the foreign key handles.
 */
export async function DELETE(
    request: Request,
    context: { params: Promise<{ id: string; artifactId: string }> }
) {
    try {
        const auth = await requireAuth(request);
        const { id, artifactId } = await context.params;

        return NextResponse.json({ frames: await deleteCapture(id, artifactId, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Write or clear a capture's caption. Whoever may discard it may caption it (§9).
 */
export async function PATCH(
    request: Request,
    context: { params: Promise<{ id: string; artifactId: string }> }
) {
    try {
        const auth = await requireAuth(request);
        const { id, artifactId } = await context.params;
        const body = updateCaptureSchema.parse(await request.json());

        return NextResponse.json(renameCapture(id, artifactId, body.label, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
