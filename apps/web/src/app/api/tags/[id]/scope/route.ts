import { NextResponse } from "next/server";

import { tagScopeSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { publishTag, unpublishTag } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Moves a tag between the two tagging systems (§6).
 *
 * Its own route rather than a field on `PATCH /api/tags/[id]`, and the reason is the
 * authorization rather than the shape. Everything that route does is administrator-only for a
 * public tag; this is the owner's and **not** an administrator's, because moving somebody's
 * private tag in or out of the library is a decision about their collection. One route with
 * two opposite guards reads as one permission.
 *
 * Publishing carries every item you have put the tag on into public view, and unpublishing is
 * refused once anybody else has used it.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { scope } = await request.json().then((body: unknown) => ({
            scope: tagScopeSchema.parse((body as { scope: unknown }).scope),
        }));

        return NextResponse.json(
            scope === "public" ? publishTag(id, auth) : unpublishTag(id, auth)
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
