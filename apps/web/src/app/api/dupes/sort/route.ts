import { NextResponse } from "next/server";

import { dupeSortSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { sortGroup } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Sorts a look-alike group into sets of the same thing (§10i), and resolves the sets that name a
 * keeper. Admin only; trashing needs `delete` as well.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = dupeSortSchema.parse(await request.json());

        return NextResponse.json(await sortGroup(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
