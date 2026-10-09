import { cookies } from "next/headers";

import { AuthenticationError, AuthorizationError, type Scope } from "@private-stock/core";
import { mediaRootRepo, refreshTokenRepo, userRepo } from "@private-stock/db";

import { authContext, sessionUser } from "./authCache";
import { verifyAccessToken, verifyMediaToken } from "./tokens";
import { REFRESH_COOKIE } from "./cookies";

/**
 * Request authentication.
 *
 * The token carries the user id and scopes, but authorization comes from the *user row*, not
 * from the token: a disabled account stops working when it is disabled rather than when its
 * token expires, and scopes changed by an admin take effect the same way. The JWT is a cheap
 * authentication proof, not a cache of authorization state.
 *
 * The row is read through `authCache`, which keeps it for a minute and is emptied by every
 * service that changes it (§20). The returned context may be shared between requests, so it is
 * read-only by convention: nothing may mutate it.
 */

export interface AuthContext {
    userId: string;
    email: string;
    displayName: string;
    scopes: Scope[];
    /** Root ids this user may see. Every library query is scoped by these (§6). */
    accessibleRootIds: string[];
    /** Current password generation. Signed media tokens are minted against it (§12d). */
    tokenEpoch: number;
}

const parseScopeList = (raw: string): Scope[] =>
    raw
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope): scope is Scope => scope === "admin" || scope === "delete");

const bearerFrom = (request: Request): string | null => {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) {
        return null;
    }

    return header.slice("Bearer ".length).trim() || null;
};

/**
 * Authenticate a request, or throw.
 *
 * Accepts the Bearer token normally. `allowCookie` additionally permits the refresh cookie
 * to stand in — needed only for `EventSource` and `<video>`/`<img>` element requests, which
 * cannot set headers. Those are opt-in rather than the default, so a CSRF-able endpoint has
 * to say so explicitly.
 */
export const requireAuth = async (
    request: Request,
    options: { allowCookie?: boolean } = {}
): Promise<AuthContext> => {
    let userId: string | null = null;

    const token = bearerFrom(request);

    if (token) {
        userId = verifyAccessToken(token)?.sub ?? null;
    }

    if (!userId && options.allowCookie) {
        const store = await cookies();
        const refresh = store.get(REFRESH_COOKIE)?.value;

        if (refresh) {
            userId = sessionUser(refresh, () => refreshTokenRepo.findLive(refresh)?.userId ?? null);
        }
    }

    if (!userId) {
        throw new AuthenticationError("Sign in to continue");
    }

    return contextFor(userId);
};

/**
 * Build the request's authorization state from a user id.
 *
 * Deliberately the only way an `AuthContext` is produced, whatever proved the identity. A
 * signed media token names a user and nothing else, so scopes and root access are read here
 * exactly as they are for a Bearer token — which is what makes withdrawing a library take
 * effect when it is withdrawn rather than at the token's expiry.
 */
const contextFor = (userId: string, requireEpoch?: number): AuthContext => {
    const context = authContext(userId, () => buildContext(userId));

    /**
     * A token minted before the password changed is dead.
     *
     * Checked here rather than at the call site so it cannot be forgotten by whatever
     * presents a token next. Equality, not ordering: the epoch is an opaque generation
     * counter, and a token claiming a *newer* one is as wrong as one claiming an older.
     */
    if (requireEpoch !== undefined && context.tokenEpoch !== requireEpoch) {
        throw new AuthenticationError("Sign in to continue");
    }

    return context;
};

/** Read the user and their roots. Throws for an account that may not sign in. */
const buildContext = (userId: string): AuthContext => {
    const user = userRepo.findById(userId);

    if (!user || user.disabled) {
        throw new AuthenticationError("Sign in to continue");
    }

    return {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        scopes: parseScopeList(user.scopes),
        accessibleRootIds: mediaRootRepo.accessibleRootIds(user.id),
        tokenEpoch: user.tokenEpoch,
    };
};

/** How a media request proved who it was. Decides whether CORS headers are safe to send. */
export type MediaAuthVia = "header" | "token" | "cookie";

export interface MediaAuth {
    auth: AuthContext;
    via: MediaAuthVia;
}

/**
 * Authenticate a request for the bytes of one specific item (§12d).
 *
 * Three credentials, in descending order of confinement:
 *
 * - a Bearer token, when the caller is `fetch` and can set headers;
 * - a **signed media token** in `?t=`, scoped to this one `mediaId` — the only credential a
 *   cast receiver or any other non-browser client can carry;
 * - the refresh cookie, the standing concession to `<video>` and `<img>`, which cannot set
 *   headers and have no way to be handed a token by the markup that references them.
 *
 * The token's `mediaId` is checked against the item actually being requested. Without that
 * the binding would be decorative: a token minted for one file would read any other, which
 * is the entire difference between this and a second session credential.
 */
export const requireMediaAuth = async (request: Request, mediaId: string): Promise<MediaAuth> => {
    const bearer = bearerFrom(request);

    if (bearer) {
        const claims = verifyAccessToken(bearer);

        if (claims) {
            return { auth: contextFor(claims.sub), via: "header" };
        }
    }

    const signed = new URL(request.url).searchParams.get("t");

    if (signed) {
        const claims = verifyMediaToken(signed);

        /**
         * A token for a different item is rejected outright rather than falling through to
         * the cookie. Falling through would serve the bytes anyway to a browser that happens
         * to be signed in, which would make a mis-scoped token look like it worked.
         */
        if (!claims || claims.mediaId !== mediaId) {
            throw new AuthenticationError("Sign in to continue");
        }

        return { auth: contextFor(claims.sub, claims.epoch), via: "token" };
    }

    const store = await cookies();
    const refresh = store.get(REFRESH_COOKIE)?.value;
    const userId = refresh
        ? sessionUser(refresh, () => refreshTokenRepo.findLive(refresh)?.userId ?? null)
        : null;

    if (!userId) {
        throw new AuthenticationError("Sign in to continue");
    }

    return { auth: contextFor(userId), via: "cookie" };
};

/**
 * Headers that let a device on another origin read these bytes.
 *
 * Sent **only** for a request authenticated by a signed token. A cookie-authenticated
 * request carries ambient authority, and answering one with `Allow-Origin: *` would let any
 * page in the browser read the user's library cross-origin — the precise thing the same-origin
 * policy is preventing today. With a token there is no ambient credential to borrow: the
 * caller had to be given the URL, and the URL is good for one item.
 *
 * `Allow-Credentials` is deliberately absent, and must stay absent — it is incompatible with
 * a wildcard origin, and the whole point here is that no credential rides along.
 */
export const corsHeadersFor = (via: MediaAuthVia): Record<string, string> =>
    via === "token"
        ? {
              "Access-Control-Allow-Origin": "*",
              // Without these the receiver can see the response but not the range metadata,
              // and seeking silently stops working.
              "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
          }
        : {};

/**
 * Require a scope.
 *
 * `admin` does not imply `delete` and vice versa (§18.1) — an administrator is not
 * automatically someone who should be removing files, and a curator is not an administrator.
 */
export const requireScope = (auth: AuthContext, scope: Scope): void => {
    if (!auth.scopes.includes(scope)) {
        throw new AuthorizationError(`This action requires the "${scope}" permission`);
    }
};
