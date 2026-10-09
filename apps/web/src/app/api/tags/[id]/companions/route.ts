import { NextResponse } from "next/server";

import { tagProfileQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getTagCompanions } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * "Appears with" on a tag's page: the people a performer is seen with, the first few with a
 * strip of what they share (§6 "Tags").
 *
 * Its own request so the page never waits on it: the profile draws first and this is asked for
 * once the section nears the viewport. `seed` is the profile's, so the strips match the visit.
 * Visibility is the profile's too -- a private tag is a 404 to anybody but its owner.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { seed } = tagProfileQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(getTagCompanions(id, seed, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
