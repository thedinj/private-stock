import jwt from "jsonwebtoken";

import {
    accessTokenClaimsSchema,
    mediaTokenClaimsSchema,
    type AccessTokenClaims,
    type MediaTokenClaims,
    type Scope,
} from "@private-stock/core";
import { loadConfig, resolveSecret } from "@private-stock/core/server";

/**
 * JWT access tokens.
 *
 * Short-lived by design: the token carries `scopes`, so an admin demoting a user would
 * otherwise wait for expiry before it took effect. Fifteen minutes bounds that window while
 * keeping the refresh cookie the thing that actually maintains a session.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

/**
 * How long a refresh token stays usable after a refresh replaced it (§12).
 *
 * Long enough to cover two tabs reloading together, or a reload that cut off a refresh the
 * server had already finished — the cases that signed people out on every code change in
 * development. Short enough that a stolen token is still dead once its owner has refreshed:
 * the window only reopens what was replaced seconds ago, never anything signed out.
 */
export const REFRESH_ROTATION_GRACE_SECONDS = 30;

/**
 * How long a signed media URL stays good (§12d).
 *
 * Governed by watch duration, not by session security. A cast receiver holds a URL for the
 * length of a film and has no refresh flow to fall back on, so a lifetime measured in minutes
 * would strand playback part-way through with nothing the user could do about it.
 *
 * What makes twenty-four hours acceptable is the binding to a single `mediaId`: a leaked
 * token is a day's access to one file the holder already had, not to the library. Revocation
 * does not wait for expiry either — the user row and their root access are re-read on every
 * request, so disabling an account or withdrawing a library kills outstanding tokens at once.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 24 * 60 * 60;

let cachedSecret: string | null = null;

const secret = (): string => {
    if (!cachedSecret) {
        cachedSecret = resolveSecret(loadConfig());
    }

    return cachedSecret;
};

export const signAccessToken = (userId: string, scopes: Scope[]): string =>
    jwt.sign({ scopes }, secret(), {
        subject: userId,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        algorithm: "HS256",
    });

/** Returns null for anything that does not verify — expired, tampered, or wrong shape. */
export const verifyAccessToken = (token: string): AccessTokenClaims | null => {
    try {
        const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
        const parsed = accessTokenClaimsSchema.safeParse(decoded);

        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
};

/**
 * Mint a URL-bearing credential for one item.
 *
 * Callers must have already established that this user may see this media. Signing is the
 * last step, not the check.
 */
export const signMediaToken = (userId: string, mediaId: string, epoch: number): string =>
    jwt.sign({ mediaId, epoch, purpose: "media" }, secret(), {
        subject: userId,
        expiresIn: MEDIA_TOKEN_TTL_SECONDS,
        algorithm: "HS256",
    });

/**
 * Returns null for anything that does not verify, including an access token.
 *
 * The schema requires `purpose: "media"`, so a token minted for API calls cannot be pasted
 * into a URL, and a media token cannot be presented as a Bearer credential.
 */
export const verifyMediaToken = (token: string): MediaTokenClaims | null => {
    try {
        const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
        const parsed = mediaTokenClaimsSchema.safeParse(decoded);

        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
};
