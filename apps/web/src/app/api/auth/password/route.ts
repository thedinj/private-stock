import { NextResponse } from "next/server";

import { changePasswordSchema } from "@private-stock/core";

import { REFRESH_COOKIE, refreshCookieOptions } from "@/lib/auth/cookies";
import { checkPasswordChangeRate } from "@/lib/auth/sessionRateLimit";
import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { changePassword } from "@/lib/services/authService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Change your own password (§12d).
 *
 * Header-authenticated with no `allowCookie`: an endpoint that revokes every session on the
 * account is the last one to accept the ambient authority that makes CSRF possible.
 *
 * Every other session ends, and so does every signed media URL. This one is handed a fresh
 * refresh cookie so it does not end with them (see `changePassword`) — setting a cookie in the
 * response is not accepting one, so the no-`allowCookie` rule above still holds. The body says
 * nothing beyond success — there is no count of what was revoked, because a number the user cannot
 * act on would only raise questions about devices they have already forgotten.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);

        // Before the body is parsed and long before `changePassword` reaches bcrypt: this
        // endpoint verifies the current password at cost 12 before rejecting anything, which
        // unmetered is an unbounded CPU oracle on the box that is also transcoding (§17).
        checkPasswordChangeRate(auth.userId);

        const body = changePasswordSchema.parse(await request.json());

        const kept = await changePassword(auth.userId, body, request.headers.get("user-agent"));

        const response = NextResponse.json({ ok: true });

        response.cookies.set(REFRESH_COOKIE, kept.refreshToken, {
            ...refreshCookieOptions(request, kept.refreshExpiresAt),
        });

        return response;
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
