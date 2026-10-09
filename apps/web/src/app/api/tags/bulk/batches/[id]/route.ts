import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { undoBulkTag } from "@/lib/services/bulkTagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Withdraws a bulk tagging batch.
 *
 * Deletes exactly the assignments that batch created, so a tag somebody typed by hand on one
 * of the same items is left alone. The batch record itself survives, because after the undo
 * it is the only account of what happened.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(undoBulkTag(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
