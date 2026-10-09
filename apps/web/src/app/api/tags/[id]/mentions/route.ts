import { NextResponse } from "next/server";

import { mentionRefusalSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { refuseMentions } from "@/lib/services/mentionService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** "Not them", from "Find untagged" (§5d): items naming the tag that are somebody else. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const input = mentionRefusalSchema.parse(await request.json());

        return NextResponse.json(refuseMentions(id, input, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
