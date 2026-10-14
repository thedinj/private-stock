import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getTagNames } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * What a filter's tag ids are called (§14e), for the chips above the grid and anything that
 * describes the filter in words. Ids the viewer may not see, or that have gone, are left out.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const ids = (new URL(request.url).searchParams.get("ids") ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .slice(0, 200);

        return NextResponse.json(getTagNames(ids, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
