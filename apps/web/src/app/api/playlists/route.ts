import { NextResponse } from "next/server";

import { createPlaylistSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createPlaylist, listPlaylists } from "@/lib/services/playlistService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** This viewer's playlists, plus everything anyone has shared. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ playlists: listPlaylists(auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = createPlaylistSchema.parse(await request.json());

        return NextResponse.json(createPlaylist(body, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
