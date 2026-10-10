import { NextResponse } from "next/server";

import { performerPeopleDecisionSchema, performerPeopleQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decidePerformerPeople, performerPeople } from "@/lib/services/performerFacesService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** A performer's Faces tab (§5f "Their faces"): one section of it, a page at a time. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const query = performerPeopleQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(performerPeople(id, query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Take back, pick, or restore a page of cards. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const decision = performerPeopleDecisionSchema.parse(await request.json());

        return NextResponse.json(decidePerformerPeople(id, decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
