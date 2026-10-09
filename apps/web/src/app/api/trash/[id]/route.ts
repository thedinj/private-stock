import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { purgeEntry } from "@/lib/services/trashService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Destroys an item ahead of its retention window. Admin only, and irreversible.
 *
 * DELETE rather than POST because this one genuinely is a deletion — the item, its bytes and
 * everything recorded about it. Only the audit entry survives.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        purgeEntry(id, auth);

        return NextResponse.json({ queued: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
