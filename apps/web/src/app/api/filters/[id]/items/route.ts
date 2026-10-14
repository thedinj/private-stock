import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listMediaOffThread } from "@/lib/services/mediaService";
import { resolveSavedQuery } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const pageSchema = z.object({ page: z.coerce.number().int().min(0).default(0) });

/**
 * One page of a saved filter, in the filter's own sort.
 *
 * Named `items` to match a playlist's, because a client renders both the same way and there
 * is no reason for it to know which kind of list it was handed.
 *
 * The query is resolved on the server from the stored filter rather than rebuilt by the
 * client, so opening a saved filter cannot drift from what was saved. Only the page comes
 * from the request, because the page is a position and the filter is not.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { page } = pageSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
        const { query, overlayUserId } = resolveSavedQuery(id, page, auth);

        return NextResponse.json(await listMediaOffThread(query, auth, overlayUserId));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
