import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { playOneClip } from "@/lib/services/libraryListService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** One of your clips as the player takes it, for the clip page (§14e "Playing the small kinds"). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(playOneClip(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
