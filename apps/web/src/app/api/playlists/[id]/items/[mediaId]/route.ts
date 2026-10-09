import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { removePlaylistItem } from "@/lib/services/playlistService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Removes one item from the playlist. The media itself is untouched. */
export async function DELETE(
    request: Request,
    context: { params: Promise<{ id: string; mediaId: string }> }
) {
    try {
        const auth = await requireAuth(request);
        const { id, mediaId } = await context.params;

        removePlaylistItem(id, mediaId, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
