import { NextResponse } from "next/server";

import { registerRequestSchema } from "@private-stock/core";

import { readSmallJson, rejectCrossSite } from "@/lib/auth/requestGuards";
import { checkRegisterRate } from "@/lib/auth/sessionRateLimit";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { register } from "@/lib/services/authService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Create an account from an invitation (§12c).
 *
 * Unauthenticated by necessity — the caller has no account yet, which is the point — and
 * therefore the only route in the app where a stranger on the internet is meant to get a
 * useful answer. The invitation code stands in for authentication, and the service decides
 * whether it stands.
 *
 * Creates the account and stops there. The page signs in afterwards with the password just
 * chosen, exactly as `/setup` does; issuing a session here too would mint a refresh token
 * that the sign-in immediately replaces, leaving a live credential nobody holds.
 */
export async function POST(request: Request) {
    try {
        // Before the body is parsed, so a refused attempt costs neither the invitation lookup
        // nor the bcrypt hash behind it.
        rejectCrossSite(request);
        checkRegisterRate(request);

        const body = registerRequestSchema.parse(await readSmallJson(request));

        return NextResponse.json({ user: await register(body) }, { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
