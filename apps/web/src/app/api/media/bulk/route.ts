import { NextResponse } from "next/server";

import { bulkActionSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { applyBulkAction } from "@/lib/services/bulkActionService";

// Declared literally in every route — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One action over a set somebody ticked (§14b).
 *
 * POST rather than a verb per action, because the selection is the subject and the action is
 * a parameter of it — four endpoints would each have to re-state the same id list, the same
 * visibility rule and the same partial-failure shape.
 *
 * Answers 200 with per-item failures rather than an error status when some items could not
 * be done. That is not a swallowed error: a selection spanning a writable root and a
 * read-only one has no single status code that is true, and the body says exactly which
 * items failed and why.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = bulkActionSchema.parse(await request.json());

        return NextResponse.json(await applyBulkAction(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
