import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { AuthenticationError } from "@private-stock/core";

import { REFRESH_COOKIE, refreshCookieOptions } from "@/lib/auth/cookies";
import { checkRefreshRate } from "@/lib/auth/sessionRateLimit";
import { ACCESS_TOKEN_TTL_SECONDS } from "@/lib/auth/tokens";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { refresh } from "@/lib/services/authService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function POST(request: Request) {
    try {
        // A ceiling on volume rather than a guard on the token, which is 128 random bits and
        // not going to be guessed. Every call is a read of the file the worker also holds.
        checkRefreshRate(request);

        const store = await cookies();
        const token = store.get(REFRESH_COOKIE)?.value;

        if (!token) {
            throw new AuthenticationError("Session expired");
        }

        const session = await refresh(token, request.headers.get("user-agent"));

        const response = NextResponse.json({
            accessToken: session.accessToken,
            expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
            user: session.user,
        });

        response.cookies.set(REFRESH_COOKIE, session.refreshToken, {
            ...refreshCookieOptions(request, session.refreshExpiresAt),
        });

        return response;
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
