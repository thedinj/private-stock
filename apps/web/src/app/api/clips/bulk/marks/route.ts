import { NextResponse } from "next/server";

import { clipMarksSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { markClips } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Stars or a heart on your clips, one or many (§14d "Clips in the library"). */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = clipMarksSchema.parse(await request.json());

        return NextResponse.json(markClips(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
