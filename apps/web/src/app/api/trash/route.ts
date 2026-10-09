import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { emptyTrash, listTrash, loadTrashSettings } from "@/lib/services/trashService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

/** What is in the bin, and how long it stays. Admin only — see the service for why. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);
        const { limit, offset } = querySchema.parse(params);

        return NextResponse.json({
            ...listTrash(auth, limit, offset),
            settings: loadTrashSettings(),
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Empties the bin now: every entry is purged, for good (§10).
 *
 * Admin only, like purging one entry. Entries whose bytes are still being moved in are left
 * for a later empty -- the response says how many.
 */
export async function DELETE(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(emptyTrash(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
