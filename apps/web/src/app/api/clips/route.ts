import { NextResponse } from "next/server";

import { clipQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listClips } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The clip browser: **this viewer's own spans**, filtered, searched and paged.
 *
 * Never anybody else's. A clip is private raw material (§14d), and the only way one reaches
 * another account is as an entry in a reel they can open.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = clipQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

        return NextResponse.json(listClips(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
