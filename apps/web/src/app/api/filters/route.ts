import { NextResponse } from "next/server";

import { createSavedFilterSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createSavedFilter, listSavedFilters } from "@/lib/services/savedFilterService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** This account's saved filters, pinned ones first. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ filters: listSavedFilters(auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = createSavedFilterSchema.parse(await request.json());

        return NextResponse.json(createSavedFilter(body, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
