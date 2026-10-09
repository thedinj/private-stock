import { NextResponse } from "next/server";

import { dupeResolveSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { resolveGroups } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Keeps one copy of each group and sends the named others to the bin (§10c).
 *
 * A page of groups per request, because the triage sheet is accepted a page at a time. Separate
 * from `review`, because the two are different kinds of act: one records a judgement and is
 * reversible by a second click, this one moves files and is reversible only by an administrator
 * restoring them.
 *
 * Needs `admin` (the whole page does) *and* `delete`. Partial success comes back per group
 * rather than as an error status, because a stale row or a full volume must not undo the rest.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = dupeResolveSchema.parse(await request.json());

        return NextResponse.json(await resolveGroups(body.items, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
