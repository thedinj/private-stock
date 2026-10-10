import { NextResponse } from "next/server";

import { suggestionDecisionSchema, suggestionsQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideSuggestions, suggestions } from "@/lib/services/suggestionService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Suggestions (§5f): one performer's, surest first, a page at a time. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = suggestionsQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(suggestions(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Say who the people on a page of cards are: one decision. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const decision = suggestionDecisionSchema.parse(await request.json());

        return NextResponse.json(decideSuggestions(decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
