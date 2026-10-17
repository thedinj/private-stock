import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getPlaybackCheck } from "@/lib/services/playbackCheckService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** The playback check's test set: unplayable videos by kind, with samples (§8). Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(getPlaybackCheck(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
