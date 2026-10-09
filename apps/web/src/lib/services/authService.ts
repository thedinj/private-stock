import {
    AuthenticationError,
    ConflictError,
    ValidationError,
    type ChangePasswordInput,
    type LoginRequest,
    type RegisterRequest,
    type SessionUser,
    type Scope,
} from "@private-stock/core";
import { refreshTokenRepo, userRepo } from "@private-stock/db";

import { forgetAuth } from "../auth/authCache";
import { dummyHashFor, hashPassword, verifyPassword } from "../auth/password";
import {
    REFRESH_ROTATION_GRACE_SECONDS,
    REFRESH_TOKEN_TTL_DAYS,
    signAccessToken,
} from "../auth/tokens";

/**
 * Authentication decisions. Routes handle HTTP; this decides who someone is.
 */

const parseScopes = (raw: string): Scope[] =>
    raw
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope): scope is Scope => scope === "admin" || scope === "delete");

export const toSessionUser = (user: {
    id: string;
    email: string;
    displayName: string;
    scopes: string;
}): SessionUser => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    scopes: parseScopes(user.scopes),
});

export interface AuthenticatedSession {
    accessToken: string;
    refreshToken: string;
    refreshExpiresAt: Date;
    user: SessionUser;
}

export const login = async (
    input: LoginRequest,
    userAgent: string | null
): Promise<AuthenticatedSession> => {
    const user = userRepo.findByEmail(input.email);

    // Always run a comparison, even when the user does not exist, so response time does not
    // reveal which addresses are registered.
    const matches = await verifyPassword(input.password, user?.password ?? dummyHashFor());

    if (!user || !matches || user.disabled) {
        // One message for every failure mode: a distinct "no such account" is an
        // enumeration oracle, and a distinct "account disabled" confirms a real one.
        throw new AuthenticationError("Incorrect email or password");
    }

    const session = toSessionUser(user);
    const refresh = refreshTokenRepo.issue(user.id, REFRESH_TOKEN_TTL_DAYS, userAgent);

    return {
        accessToken: signAccessToken(user.id, session.scopes),
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt,
        user: session,
    };
};

/**
 * Exchange a refresh token for a new access token, rotating the refresh token.
 *
 * Rotation means a stolen refresh token is usable only until the legitimate client next
 * refreshes, at which point the thief's copy is already revoked — after a grace of
 * `REFRESH_ROTATION_GRACE_SECONDS`, which is what lets two requests race on one cookie
 * without signing the person out.
 */
export const refresh = async (
    token: string,
    userAgent: string | null
): Promise<AuthenticatedSession> => {
    const live = refreshTokenRepo.findLive(token);
    /**
     * A token rotated a moment ago by a request racing this one on the same cookie (§12).
     *
     * It gets a fresh token of its own rather than the one the race produced, which cannot be
     * handed out twice because only its hash is stored. The token it presented stays revoked,
     * and nothing that was revoked by signing out or a password change qualifies.
     */
    const row = live ?? refreshTokenRepo.findRecentlyRotated(token, REFRESH_ROTATION_GRACE_SECONDS);

    if (!row) {
        throw new AuthenticationError("Session expired");
    }

    const user = userRepo.findById(row.userId);

    if (!user || user.disabled) {
        throw new AuthenticationError("Session expired");
    }

    const next = live
        ? // Null when another request rotated it between the read and the write: that request
          // won the race, and this one is inside the grace by definition.
          (refreshTokenRepo.rotate(token, user.id, REFRESH_TOKEN_TTL_DAYS, userAgent) ??
          refreshTokenRepo.issue(user.id, REFRESH_TOKEN_TTL_DAYS, userAgent))
        : refreshTokenRepo.issue(user.id, REFRESH_TOKEN_TTL_DAYS, userAgent);
    const session = toSessionUser(user);

    return {
        accessToken: signAccessToken(user.id, session.scopes),
        refreshToken: next.token,
        refreshExpiresAt: next.expiresAt,
        user: session,
    };
};

export const logout = (token: string | undefined): void => {
    if (token) {
        refreshTokenRepo.revoke(token);
        // A signed-out cookie must stop working now, not when its cache entry expires.
        forgetAuth();
    }
};

/**
 * Create an account from an invitation (§12c).
 *
 * The only way a second account comes into being. There is no open-registration setting and
 * deliberately no place to add one: a toggle whose ON state hands an internet-facing library
 * of private material to whoever finds the URL is a control that exists to be set wrong once.
 *
 * **Order is load-bearing.** The invitation is checked first, so that the email-already-taken
 * answer is reachable only by somebody holding a live code. That answer is an account
 * enumeration oracle -- ask about an address, learn whether its owner has an account here --
 * and putting it behind the invitation is what keeps it from being a public one. The person
 * who does hold a code needs the real answer, because "your address is already registered" is
 * the difference between signing in and giving up.
 *
 * Returns the created account rather than a session, and the page signs in with the password
 * the person just chose -- the same shape `/setup` uses. Issuing a session here as well would
 * mint a refresh token that the sign-in immediately replaces, leaving a valid credential in
 * the database that nobody holds and nothing revokes until it expires.
 */
export const register = async (input: RegisterRequest): Promise<SessionUser> => {
    // Imported here rather than at the top: `invitationService` imports `withAuth`, which
    // pulls the request-scoped auth machinery into the module graph. Keeping it local to the
    // one function that needs it keeps `authService` importable from a plain script.
    const { consumeInvitation } = await import("./invitationService");

    const invitation = consumeInvitation(input.invitationCode);

    if (userRepo.findByEmail(input.email)) {
        throw new ConflictError("That email address is already registered");
    }

    const user = userRepo.createUser({
        email: input.email,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        // From the invitation, never from the request. A scope the person asked for would be
        // a scope they granted themselves.
        scopes: invitation.scopes.join(","),
        invitationId: invitation.invitationId,
    });

    return toSessionUser(user);
};

export const createUser = async (input: {
    email: string;
    displayName: string;
    password: string;
    scopes: Scope[];
}): Promise<SessionUser> => {
    if (userRepo.findByEmail(input.email)) {
        throw new ConflictError("That email address is already registered");
    }

    const user = userRepo.createUser({
        email: input.email,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        scopes: input.scopes.join(","),
    });

    return toSessionUser(user);
};

/**
 * Change your own password, ending every other session and every signed URL it authorised.
 *
 * Three things happen and all three are the point: the hash changes, `setPassword` bumps the
 * account's `tokenEpoch` — which invalidates every outstanding signed media token (§12d) —
 * and every refresh token is revoked. Someone changing a password is trying to lock something
 * out, so leaving any of the three behind would defeat the reason they did it.
 *
 * **Except the device that asked.** It is handed one new refresh token, minted after the
 * revocation, so every *other* session ends and this one carries on. Keeping only the access
 * token used to look like the same thing and was not: it expires within fifteen minutes, the
 * refresh behind it had just been revoked with the rest, and the person who had just secured
 * their account was signed out of the tab they did it in a quarter of an hour later. The
 * epoch bump still reaches this device's signed URLs, which is harmless: it is on the account
 * page, not halfway through a video, and the next item it opens is signed afresh.
 */
export const changePassword = async (
    userId: string,
    input: ChangePasswordInput,
    userAgent: string | null
): Promise<{ refreshToken: string; refreshExpiresAt: Date }> => {
    const user = userRepo.findById(userId);

    if (!user) {
        throw new AuthenticationError("Sign in to continue");
    }

    if (!(await verifyPassword(input.currentPassword, user.password))) {
        // Not an AuthenticationError: the session is perfectly valid, and answering with one
        // would have the client discard a good token and send the user back to a login page.
        throw new ValidationError("That is not your current password");
    }

    userRepo.setPassword(userId, await hashPassword(input.newPassword));
    refreshTokenRepo.revokeAllForUser(userId);
    forgetAuth();

    const kept = refreshTokenRepo.issue(userId, REFRESH_TOKEN_TTL_DAYS, userAgent);

    return { refreshToken: kept.token, refreshExpiresAt: kept.expiresAt };
};
