import { NextResponse } from "next/server";

import { itemPeopleDecisionSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { decideItemPeople, itemPeople } from "@/lib/services/itemPeopleService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** People in this item (§5f): every person in it, and the performers its text names. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(itemPeople(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Say who a person in it is, or is not; or tag, or refuse, a performer its text names. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const decision = itemPeopleDecisionSchema.parse(await request.json());

        return NextResponse.json(decideItemPeople(id, decision, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
