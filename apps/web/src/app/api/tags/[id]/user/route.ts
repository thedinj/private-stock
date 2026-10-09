import { NextResponse } from "next/server";

import { userTagPatchSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setTagFavorite } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * This viewer's own marks on one tag (§6 "Favourite tags").
 *
 * Separate from PATCH `/api/tags/[id]` for the item route's reason: favouriting a performer is
 * not editing the vocabulary, needs no curator, and must not race somebody else's favourite
 * through one resource. No ChangeLog row either -- it is one person's private state.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = userTagPatchSchema.parse(await request.json());

        return NextResponse.json(setTagFavorite(id, body.favorite, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
