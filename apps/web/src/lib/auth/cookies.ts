import { type ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";

import { isHttpsRequest } from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/**
 * The refresh cookie.
 *
 * `SameSite=Lax` rather than Strict: Strict would drop the cookie when someone follows a
 * link into the app from elsewhere, logging them out for no security gain here — Lax already
 * blocks the cross-site POST that CSRF needs.
 *
 * `secure` is conditional because the app is genuinely used over plain HTTP on a LAN. A
 * cookie marked Secure is silently dropped there, which presents as "login does nothing".
 * Behind the reverse proxy, `x-forwarded-proto` restores it — but only when `trustedProxyHops`
 * says there is a proxy to hear it from, since otherwise the header is the caller's to set.
 */

export const REFRESH_COOKIE = "ps_refresh";

export const refreshCookieOptions = (
    request: Request,
    expiresAt: Date
): Partial<ResponseCookie> => {
    return {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttpsRequest(request, loadConfig().trustedProxyHops),
        path: "/",
        expires: expiresAt,
    };
};

export const clearedCookieOptions = (): Partial<ResponseCookie> => ({
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
});
