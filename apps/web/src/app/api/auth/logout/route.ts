import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { REFRESH_COOKIE, clearedCookieOptions } from "@/lib/auth/cookies";
import { rejectCrossSite } from "@/lib/auth/requestGuards";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { logout } from "@/lib/services/authService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function POST(request: Request) {
    try {
        // A signed-out visitor is the whole of what a forged sign-out achieves, but it is
        // still somebody else's page deciding it.
        rejectCrossSite(request);

        const store = await cookies();
        logout(store.get(REFRESH_COOKIE)?.value);

        const response = NextResponse.json({ ok: true });
        response.cookies.set(REFRESH_COOKIE, "", clearedCookieOptions());
        // Covers and captures are cached for a year as `immutable` (§9), and signing out does
        // not otherwise remove them — on a shared browser, the next person to use it would be
        // browsing a disk cache of someone else's library. Browsers honour this only over
        // HTTPS (or on localhost); a plain-HTTP LAN deployment gets nothing from it.
        response.headers.set("Clear-Site-Data", '"cache"');

        return response;
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
