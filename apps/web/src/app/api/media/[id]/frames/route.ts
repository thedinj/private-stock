import { NextResponse } from "next/server";

import { captureFrameSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { captureFrame } from "@/lib/services/frameService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Capture the frame at a position of the original (§13).
 *
 * Synchronous, which is the one place ffmpeg runs inside a request. A single frame is a seek
 * and one decode — `-ss` before `-i` is what makes that true regardless of the file's length
 * — and the whole value of the button is that the picture has changed by the time you are
 * back at the grid. A queued job cannot promise that: the worker's idle poll alone is two
 * seconds, and longer while it is busy.
 *
 * There is no GET beside this. The frames travel on the item's detail response, which the
 * page holding the strip has already fetched.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = captureFrameSchema.parse(await request.json());

        return NextResponse.json(await captureFrame(id, body.atMs, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
