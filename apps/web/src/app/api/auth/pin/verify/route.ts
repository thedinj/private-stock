import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { verifyPinSchema } from "@private-stock/core";

import { REFRESH_COOKIE, clearedCookieOptions } from "@/lib/auth/cookies";
import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { verifyPin } from "@/lib/services/pinService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Unlock a locked screen (§12c "The screen lock").
 *
 * Header-authenticated. The refresh cookie is read only so the last wrong try can end this
 * device's session — and ending a session is the one thing a forged request could do with it.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = verifyPinSchema.parse(await request.json());

        const store = await cookies();
        const result = await verifyPin(auth.userId, body.pin, store.get(REFRESH_COOKIE)?.value);

        const response = NextResponse.json(result);

        if (result.signedOut) {
            response.cookies.set(REFRESH_COOKIE, "", clearedCookieOptions());
        }

        return response;
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
