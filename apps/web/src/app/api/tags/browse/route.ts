import { NextResponse } from "next/server";

import { tagBrowseQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { browseTags } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One facet of one tagging system, a page of tags at a time, each with a filmstrip (§6 "Tags").
 *
 * The browsing counterpart of `/api/tags/vocabulary`, which is the management table: that one
 * keeps unused tags and has no pictures, this one has only tags that carry something and shows
 * a few of the things. Any signed-in user; `scope: "private"` resolves to the caller.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(browseTags(tagBrowseQuerySchema.parse(params), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
