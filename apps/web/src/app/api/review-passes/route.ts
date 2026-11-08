import { NextResponse } from "next/server";

import { createReviewPassSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createPass, listPasses } from "@/lib/services/reviewPassService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Your review passes (§14d): the request's room's, or every room's with `?rooms=all`, which
 * is the Account page's card. Only ever your own.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const rooms = new URL(request.url).searchParams.get("rooms") === "all" ? "all" : "here";

        return NextResponse.json({ passes: listPasses(auth, rooms) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** A new pass, in the request's room. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = createReviewPassSchema.parse(await request.json());

        return NextResponse.json(createPass(body.name, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
