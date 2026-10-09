import { NextResponse } from "next/server";

import { createReelSchema, reelQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createReel, listReels } from "@/lib/services/reelService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The reel index: yours and anything the house shared, most recently updated first.
 *
 * Paged, sorted and searched rather than returned whole, which is what separates a reel from a
 * collection (§14d) — there will be hundreds of these, so the index is a page and not a wall.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = reelQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

        return NextResponse.json(listReels(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = createReelSchema.parse(await request.json());

        return NextResponse.json(createReel(body, auth), { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
