import { NextResponse } from "next/server";

import { autoTagSwitchSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { switchAutoTag } from "@/lib/services/autoTagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Let faces tag by themselves, or stop them (§5f "Tagging by itself"). */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const input = autoTagSwitchSchema.parse(await request.json());

        return NextResponse.json(switchAutoTag(input, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
