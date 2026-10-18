import { NextResponse } from "next/server";

import { dupeApartQuerySchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listApart } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Sortings that kept look-alikes apart, newest first, to take back (§10i). Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(listApart(dupeApartQuerySchema.parse(params), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
