import { NextResponse } from "next/server";

import { applyTagsSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { applyTags, getMediaTags } from "@/lib/services/tagService";
import { whenNotBusy } from "@/lib/whenNotBusy";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json({ tags: getMediaTags(id, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Sets one facet's tags on this item.
 *
 * One facet per request, because "replace" has to mean something definite. A body carrying
 * every facet at once could not express "leave the studio alone" without a sentinel, and the
 * obvious reading — absent means empty — would silently clear facets the form never showed.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = applyTagsSchema.parse(await request.json());

        // Somebody is waiting on this write, so a busy database is waited out rather than
        // reported — without holding the thread. Safe to repeat: it is one transaction.
        const tags = await whenNotBusy(() => applyTags(id, body, auth));

        return NextResponse.json({ tags });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
