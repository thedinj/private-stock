import { NextResponse } from "next/server";

import { ocrRuleTagUndoSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { undoRuleTag } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Take one rule-applied tag off its item, and keep the rule from putting it back. Admin only — see the service for why. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = ocrRuleTagUndoSchema.parse(await request.json());

        return NextResponse.json(undoRuleTag(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
