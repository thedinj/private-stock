import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listCopies } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * An item's other copies, for its delete confirmation (§10d).
 *
 * Only copies in libraries the caller can see; the service says why that makes this safe to
 * offer to anybody who can see the item, where the duplicate review screen is admin-only.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(listCopies(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
