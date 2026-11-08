import { NextResponse } from "next/server";

import { renameReviewPassSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deletePass, renamePass } from "@/lib/services/reviewPassService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Rename one of your passes (§14d). Somebody else's is not found. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = renameReviewPassSchema.parse(await request.json());

        return NextResponse.json(renamePass(id, body.name, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Delete one of your passes and every mark it holds; answers with how many marks went. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(deletePass(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
