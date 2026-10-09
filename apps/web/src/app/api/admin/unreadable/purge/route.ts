import { NextResponse } from "next/server";

import { purgeUnreadableSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { purgeUnreadable } from "@/lib/services/unreadableService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Purges the chosen unreadable files from the trash, for good (§10g).
 *
 * POST, as `api/media/bulk` is: the selection is the subject. Entries still being moved in are
 * left and counted -- the response says how many.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = purgeUnreadableSchema.parse(await request.json());

        return NextResponse.json(purgeUnreadable(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
