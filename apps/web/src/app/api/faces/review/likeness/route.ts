import { NextResponse } from "next/server";

import { faceLikenessQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { faceLikeness } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** How alike each of a review row's faces is to the person it is asked about (§5f). */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const query = faceLikenessQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(faceLikeness(query, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
