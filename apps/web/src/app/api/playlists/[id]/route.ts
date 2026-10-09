import { NextResponse } from "next/server";

import { updatePlaylistSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deletePlaylist, getPlaylist, updatePlaylist } from "@/lib/services/playlistService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(getPlaylist(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Rename, re-describe, or share. Owner only — sharing grants reading and nothing more. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = updatePlaylistSchema.parse(await request.json());

        return NextResponse.json(updatePlaylist(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Deletes the playlist and its membership.
 *
 * No media is touched, and the `delete` scope is not required: that scope governs removing
 * files from a library (§18.1), which this cannot do.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        deletePlaylist(id, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
