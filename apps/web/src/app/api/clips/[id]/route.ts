import { NextResponse } from "next/server";

import { updateClipSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteClip, getClipDetail, updateClip } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One clip, with the reels holding it named.
 *
 * Top level rather than under its item, because the retime and discard dialogues are reachable
 * from a reel page where the media id is incidental.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(getClipDetail(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Retimes, renames or re-speeds a span. Every reel holding it changes with it (§14d). */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = updateClipSchema.parse(await request.json());

        return NextResponse.json(updateClip(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Discards a span, and takes it out of the reels holding it.
 *
 * Reports how many reels changed, because the confirmation said which ones would and the answer
 * ought to come back from the API rather than only from the database.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(deleteClip(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
