import { NextResponse } from "next/server";

import { ownFacePickSchema, ownFacesQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { ownFacesPage, pickOwnFace } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** "Pick their face": their own items, a page at a time, each with its faces (§5f). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const query = ownFacesQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(ownFacesPage(id, query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** "That's them" of one face on one of their items, or taken back. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const pick = ownFacePickSchema.parse(await request.json());

        return NextResponse.json(pickOwnFace(id, pick, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
