import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { restoreEntry } from "@/lib/services/trashService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Puts a deleted item back, bytes and catalog entry together. Admin only.
 *
 * Queued rather than done here: the bytes have to come back across volumes, which for a large
 * file is minutes of copying and not something to hold a request open for.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        restoreEntry(id, auth);

        return NextResponse.json({ queued: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
