import { NextResponse } from "next/server";

import { libraryQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { playClipsOffThread } from "@/lib/services/libraryListService";
import { overlayForRequest } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The Clips tab played from the top (§14e "Playing the small kinds"): its clips in the tab's
 * order, as the reel player takes them. Whatever kind is asked, this is clips.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { filter, ...params } = Object.fromEntries(new URL(request.url).searchParams);
        const query = libraryQuerySchema.parse({ ...params, kind: "clip" });
        const { kind: _kind, orVideo: _orVideo, unusedOnly: _unused, ...asked } = query;

        return NextResponse.json(
            await playClipsOffThread(query, auth, overlayForRequest(filter ?? null, asked, auth))
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
