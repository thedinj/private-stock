import {
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
    type ManagedUser,
    type SessionUser,
    type SetUserPasswordInput,
    type UpdateProfileInput,
    type UpdateUserInput,
    parseScopes,
} from "@private-stock/core";
import { refreshTokenRepo, userRepo, type UserListRow } from "@private-stock/db";

import { forgetAuth } from "@/lib/auth/authCache";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { requireScope, type AuthContext } from "@/lib/auth/withAuth";
import { toSessionUser } from "@/lib/services/authService";

/**
 * Managing the accounts that exist (§12c).
 *
 * Everything here is `admin`, except editing your own name (`updateOwnProfile`). The two rules that are not simply "check the scope":
 *
 *   - **Nobody edits themselves into a corner.** An administrator cannot remove their own
 *     `admin`, disable themselves, or delete themselves. Each would be a door locked from the
 *     inside with the key still in it — and the last one has no recovery path at all, because
 *     `/setup` only reopens when the user count reaches zero.
 *   - **The last administrator stays one.** A library nobody can administer has no recovery
 *     path at all. In practice the self-checks above already guarantee it — the caller is an
 *     enabled administrator, so demoting anybody else always leaves them — so the explicit
 *     guard is defence in depth against those checks moving.
 *
 * Both are enforced here rather than in the UI. The UI also hides the controls, which is
 * where the rule is explained; this is where it is true.
 */

const toManagedUser = (row: UserListRow, viewerId: string): ManagedUser => ({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    scopes: parseScopes(row.scopes),
    disabled: row.disabled === 1,
    createdAt: row.createdAt,
    // The label if it was given one, else the code itself — an invitation minted in a hurry
    // has no label, and "how did this person get in" still wants an answer.
    invitedAs: row.invitationLabel ?? row.invitationCode,
    isSelf: row.id === viewerId,
});

/**
 * Checked rather than left to the UNIQUE constraint, so the message can name the problem.
 * Somebody retyping an address wants to know it is taken, not to see a constraint violation.
 */
const assertEmailFree = (id: string, current: string, next: string | undefined): void => {
    if (!next || next === current) {
        return;
    }

    const holder = userRepo.findByEmail(next);

    if (holder && holder.id !== id) {
        throw new ConflictError("Another account already uses that email address");
    }
};

export const listUsers = (auth: AuthContext): ManagedUser[] => {
    requireScope(auth, "admin");

    return userRepo.listUsers().map((row) => toManagedUser(row, auth.userId));
};

/**
 * Change what an account may do, or whether it may do anything.
 *
 * Scopes and `disabled` in one call because the admin screen edits them from one row, and
 * because the checks below have to see the whole intended end state: demoting an account and
 * disabling it in two requests would pass a "last admin" check twice and still arrive
 * somewhere neither request was allowed to reach on its own.
 */
export const updateUser = (id: string, input: UpdateUserInput, auth: AuthContext): ManagedUser => {
    requireScope(auth, "admin");

    const target = userRepo.findById(id);

    if (!target) {
        throw new NotFoundError("Account not found");
    }

    const isSelf = target.id === auth.userId;
    const currentScopes = parseScopes(target.scopes);
    const nextScopes = input.scopes ?? currentScopes;
    const nextDisabled = input.disabled ?? target.disabled === 1;

    const wasAdmin = currentScopes.includes("admin");
    const willBeAdmin = nextScopes.includes("admin") && !nextDisabled;
    // Whether this account is one of the administrators the library currently *has* — which
    // a disabled one is not, and `countWithScope` agrees. Without this distinction, demoting
    // an already-disabled administrator is refused as "the only administrator" while the real
    // only administrator is the untouched caller.
    const countsNow = wasAdmin && target.disabled !== 1;

    if (isSelf && wasAdmin && !willBeAdmin) {
        throw new ConflictError(
            "You cannot remove your own administrator access. Ask another administrator to do it."
        );
    }

    if (isSelf && nextDisabled) {
        throw new ConflictError("You cannot disable your own account.");
    }

    /*
     * After this change, is anybody left who can administer the library?
     *
     * Defence in depth rather than a live path, and worth saying so: the caller is
     * necessarily an enabled administrator, so any *other* enabled administrator makes the
     * count at least two. The only account this can currently fire for is the caller's own,
     * which the self-checks above have already refused with a better message.
     *
     * It is kept because it is the actual invariant — a library nobody can administer has no
     * recovery path, since `/setup` reopens only when the account count reaches zero — and
     * because the checks that make it unreachable are three lines above it and could move.
     */
    if (countsNow && !willBeAdmin && userRepo.countWithScope("admin") <= 1) {
        throw new ConflictError(
            "This is the only administrator. Give somebody else administrator access first."
        );
    }

    assertEmailFree(id, target.email, input.email);

    if (input.displayName !== undefined || input.email !== undefined) {
        userRepo.setProfile(id, {
            ...(input.displayName !== undefined && { displayName: input.displayName }),
            ...(input.email !== undefined && { email: input.email }),
        });
    }

    if (input.scopes) {
        userRepo.setScopes(id, nextScopes.join(","));
    }

    if (input.disabled !== undefined && input.disabled !== (target.disabled === 1)) {
        userRepo.setDisabled(id, input.disabled);
    }

    // Scopes, a disabled flag and the profile all live in the cached context (§20).
    forgetAuth();

    const row = userRepo.listUsers().find((candidate) => candidate.id === id)!;

    return toManagedUser(row, auth.userId);
};

/**
 * Edit your own name, and — if you are an administrator — the address you sign in with (§12c).
 *
 * The one function here that is not admin-only. Everybody may rename themselves: the name is
 * how the household sees you and has nothing to do with how you sign in. The address is the
 * username, so it stays the administrators' to change on every account — an administrator's
 * own included, which is why it is offered on `/account` to them and to nobody else. Refused
 * rather than dropped when anybody else sends it, so a client that tried is told it failed.
 *
 * Neither disturbs sessions or signed links: the token names `sub`, and `sub` has not moved.
 */
export const updateOwnProfile = (input: UpdateProfileInput, auth: AuthContext): SessionUser => {
    if (input.email !== undefined && !auth.scopes.includes("admin")) {
        throw new AuthorizationError(
            "Only an administrator can change the email you sign in with. Ask one to do it."
        );
    }

    const self = userRepo.findById(auth.userId);

    // The token authenticated, so the account existed a moment ago; if it does not now it
    // was deleted mid-request.
    if (!self) {
        throw new AuthenticationError("Sign in to continue");
    }

    assertEmailFree(self.id, self.email, input.email);

    userRepo.setProfile(self.id, input);

    // The name and address both live in the cached context (§20).
    forgetAuth();

    return toSessionUser(userRepo.findById(self.id)!);
};

/**
 * Set somebody else's password (§12c).
 *
 * The only account recovery there is. Nothing is emailed — the "email" on an account is a
 * username that happens to look like an address — so the administrator reads the new password
 * out and the person changes it themselves afterwards, or does not.
 *
 * **The caller re-proves who they are first.** An access token is fifteen minutes of ambient
 * authority, and setting a password is the one action whose effect outlives the session that
 * performed it: with a stolen token and no re-authentication, an attacker owns every other
 * account in the library permanently. `changePassword` demands the current password for
 * exactly this reason; this is that rule applied to acting on somebody else.
 *
 * Deliberately **not** usable on your own account. Your own password change lives on `/account`
 * and requires the password you are replacing; allowing a self-reset here would be the same
 * endpoint without that check, which is the hole the paragraph above describes.
 */
export const setUserPassword = async (
    id: string,
    input: SetUserPasswordInput,
    auth: AuthContext
): Promise<void> => {
    requireScope(auth, "admin");

    const target = userRepo.findById(id);

    if (!target) {
        throw new NotFoundError("Account not found");
    }

    if (target.id === auth.userId) {
        throw new ConflictError(
            "Change your own password from your account page, where it asks for the one you are replacing."
        );
    }

    const caller = userRepo.findById(auth.userId);

    // The token authenticated, so the account existed a moment ago; if it does not now, it was
    // deleted mid-request and there is nothing to re-prove against.
    if (!caller || !(await verifyPassword(input.adminPassword, caller.password))) {
        // Not a ValidationError attached to the field: this is a failed authentication, and
        // the rate limiter the route applies counts it as one.
        throw new AuthenticationError("That is not your password");
    }

    // `setPassword` bumps the target's epoch in the same statement, which invalidates every
    // signed media URL they hold (§12d); revoking the refresh tokens ends the sessions. Both,
    // because a password reset that left either alive would not have locked anybody out.
    userRepo.setPassword(id, await hashPassword(input.password));
    refreshTokenRepo.revokeAllForUser(id);
    forgetAuth();
};

/**
 * Remove an account and everything that was only ever theirs.
 *
 * Their ratings, watch state, private tags, saved views, playlists, preferences and sessions
 * go with them, by cascade. The catalogue does not: media, public tags and shared playlists
 * belong to the library, and lose their attribution rather than themselves.
 *
 * Irreversible, and the dialogue says so with the count rather than asking whether the person
 * is sure.
 */
export const deleteUser = (id: string, auth: AuthContext): void => {
    requireScope(auth, "admin");

    const target = userRepo.findById(id);

    if (!target) {
        throw new NotFoundError("Account not found");
    }

    if (target.id === auth.userId) {
        throw new ConflictError("You cannot delete your own account.");
    }

    // As in `updateUser`: only an administrator the library currently has can be its last
    // one, and a disabled account is not one of those.
    if (
        parseScopes(target.scopes).includes("admin") &&
        target.disabled !== 1 &&
        userRepo.countWithScope("admin") <= 1
    ) {
        throw new ConflictError(
            "This is the only administrator. Give somebody else administrator access first."
        );
    }

    userRepo.deleteUser(id);
    forgetAuth();
};
