import { NextResponse } from "next/server";

import { newPeopleDecisionSchema, newPeopleQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideNewPeople, newPeople } from "@/lib/services/newPeopleService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** New people (§5f): people who match nobody known, gathered, a page at a time. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = newPeopleQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(newPeople(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Name a new person, or say they are not one person, or later. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const decision = newPeopleDecisionSchema.parse(await request.json());

        return NextResponse.json(decideNewPeople(decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
