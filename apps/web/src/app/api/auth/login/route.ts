import { NextResponse } from "next/server";

import { loginRequestSchema } from "@private-stock/core";

import { REFRESH_COOKIE, refreshCookieOptions } from "@/lib/auth/cookies";
import { checkLoginRate, clearLoginRate } from "@/lib/auth/loginRateLimit";
import { readSmallJson, rejectCrossSite } from "@/lib/auth/requestGuards";
import { ACCESS_TOKEN_TTL_SECONDS } from "@/lib/auth/tokens";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { login } from "@/lib/services/authService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function POST(request: Request) {
    try {
        rejectCrossSite(request);

        const body = loginRequestSchema.parse(await readSmallJson(request));

        // Awaited before the password is checked, so a refused attempt costs no bcrypt hash
        // and a throttled one pays its wait before the expensive part rather than after.
        await checkLoginRate(request, body.email);

        const session = await login(body, request.headers.get("user-agent"));

        clearLoginRate(body.email);

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
