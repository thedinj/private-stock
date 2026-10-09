import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { issueMediaToken } from "@/lib/services/mediaTokenService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Mint a signed URL for one item (§12d).
 *
 * POST rather than GET, despite reading nothing: it creates a credential, so it must not be
 * prefetched by a browser, retried by a proxy, or land in anyone's history.
 *
 * Authenticated by header only — no `allowCookie`. The caller is `fetch`, which can set one;
 * and an endpoint that hands out credentials is the last place to accept the ambient
 * authority that makes CSRF possible.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(issueMediaToken(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
