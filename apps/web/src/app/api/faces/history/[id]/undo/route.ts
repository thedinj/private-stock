import { NextResponse } from "next/server";

import { faceUndoSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { undoFaceDecision } from "@/lib/services/faceHistoryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Undo one face decision: what it wrote and still stands, its tags with it. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const input = faceUndoSchema.parse(await request.json());

        return NextResponse.json(undoFaceDecision(id, input, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
