import { NextResponse } from "next/server";

import { hwaccelProbeRequestSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { probeHwaccel } from "@/lib/services/hwaccelProbeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Try a hardware encoder and report what happened (§7).
 *
 * POST rather than GET, and not because anything is stored. It spawns a process, so it must
 * not be something a prefetch, a link preview or a retry can trigger on its own.
 *
 * The probed mode comes from the request body rather than from the saved setting, so the
 * button answers "would this work?" for the value on screen — before it is saved, which is
 * the moment the answer is worth having.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { hwaccel } = hwaccelProbeRequestSchema.parse(await request.json());

        return NextResponse.json(await probeHwaccel(auth, hwaccel));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
