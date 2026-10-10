import { NextResponse } from "next/server";

import { suggestionPerformersQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { suggestionPerformers } from "@/lib/services/suggestionService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Suggestions (§5f): every performer with any, and how many, most first. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = suggestionPerformersQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(suggestionPerformers(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
