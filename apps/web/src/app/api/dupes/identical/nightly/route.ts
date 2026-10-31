import { NextResponse } from "next/server";

import { identicalNightlySwitchSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { switchIdenticalNightly } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Clear identical copies every night, or stop (§10e "Every night"). Needs `admin` and `delete`;
 * the deletions are recorded against whoever turns it on.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const input = identicalNightlySwitchSchema.parse(await request.json());

        return NextResponse.json(switchIdenticalNightly(input, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
