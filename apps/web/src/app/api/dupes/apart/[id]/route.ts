import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { undoApart } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Takes a sorting back (§10i): its verdicts go, and its copies are compared again on the next
 * pass. Admin only. Touches no file.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(undoApart(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
