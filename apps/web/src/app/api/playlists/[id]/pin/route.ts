import { NextResponse } from "next/server";

import { setCollectionPinSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setPlaylistPin } from "@/lib/services/playlistService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Pin or unpin a playlist for the account making the request (§14b).
 *
 * Its own route rather than a field on the PATCH that edits the playlist, because it is a
 * different act by a different person: editing is the owner's and needs ownership, while
 * pinning is any viewer's opinion about their own sidebar and needs only the right to see the
 * thing. Folding it into the update would have meant one endpoint with two authorization rules.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = setCollectionPinSchema.parse(await request.json());

        return NextResponse.json({ playlist: setPlaylistPin(id, body.pinned, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
