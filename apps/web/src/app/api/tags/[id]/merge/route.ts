import { NextResponse } from "next/server";

import { mergeTagsSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { mergeTags } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Folds this tag into another, keeping every assignment.
 *
 * A separate endpoint rather than a rename that happens to collide, because the two have
 * different consequences and the caller has to be able to say which one it meant.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = mergeTagsSchema.parse(await request.json());

        // The count, not `{ ok: true }`. The service works out how many items moved and the
        // screen says so afterwards -- discarding it here is what made the toast read
        // "Merged -- undefined items moved".
        return NextResponse.json(mergeTags(id, body.intoTagId, auth, body.keepAlias));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
