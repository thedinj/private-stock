import { NextResponse } from "next/server";

import { updateSavedFilterSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteSavedFilter, updateSavedFilter } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Rename, re-query, pin, or reposition. Saved filters are private, so owner-only throughout. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = updateSavedFilterSchema.parse(await request.json());

        return NextResponse.json(updateSavedFilter(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        deleteSavedFilter(id, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
