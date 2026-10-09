import { NextResponse } from "next/server";

import { editClipTagsSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { editClipTags } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Adds names to one of your clip's facets, or takes them off. Returns the clip's tags. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = editClipTagsSchema.parse(await request.json());

        return NextResponse.json({ tags: editClipTags(id, body, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
