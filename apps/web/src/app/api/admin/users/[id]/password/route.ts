import { NextResponse } from "next/server";

import { setUserPasswordSchema } from "@private-stock/core";

import { checkPasswordChangeRate } from "@/lib/auth/sessionRateLimit";
import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setUserPassword } from "@/lib/services/userAdminService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Set somebody else's password (§12c).
 *
 * Header-authenticated with no `allowCookie`, exactly as `/api/auth/password` is: an endpoint
 * that ends every session on an account is the last one to accept the ambient authority that
 * makes CSRF possible. The body additionally carries the caller's own password, so a stolen
 * access token is not on its own enough to take over the other accounts in the library.
 *
 * Rate-limited against the *caller's* account, sharing the bucket with their own password
 * changes — both are this account performing password operations, and the wrong-password
 * branch here is a guess that costs a bcrypt comparison.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);

        checkPasswordChangeRate(auth.userId);

        const { id } = await context.params;
        const body = setUserPasswordSchema.parse(await request.json());

        await setUserPassword(id, body, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
