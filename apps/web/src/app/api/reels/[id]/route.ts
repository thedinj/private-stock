import { NextResponse } from "next/server";

import { updateReelSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteReel, getReel, updateReel } from "@/lib/services/reelService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(getReel(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Renames, re-describes or shares. Sharing needs the scope; unsharing deliberately does not. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = updateReelSchema.parse(await request.json());

        return NextResponse.json(updateReel(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Removes the arrangement. The clips it held are untouched — they are the owner's material. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        deleteReel(id, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
