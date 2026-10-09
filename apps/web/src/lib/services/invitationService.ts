import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
    type CreateInvitationInput,
    type Invitation,
    generateInvitationCode,
    parseScopes,
    type Scope,
} from "@private-stock/core";
import { invitationRepo, type InvitationListRow, type InvitationRow } from "@private-stock/db";

import { requireScope, type AuthContext } from "@/lib/auth/withAuth";

/**
 * Invitations (§12c).
 *
 * Minting and revoking are `admin`; using one is the only thing an unauthenticated caller can
 * do here, and it goes through `consume` below.
 *
 * **The scopes an invitation carries cannot exceed the scopes of whoever minted it.** Without
 * that rule an admin is the only kind of account there is: anybody who could mint would be
 * able to mint a code granting `admin` and use it themselves. The rule is enforced here
 * rather than in the route because it is an authorization decision, and the service layer is
 * where those live.
 */

/**
 * Why an invitation cannot be used, or null if it can.
 *
 * One function, called by both the admin list (to show a state) and registration (to refuse),
 * so the screen and the gate can never disagree about what "usable" means.
 *
 * Order matters for the message, not for the outcome: revocation is deliberate and named
 * first, expiry is the passage of time, and exhaustion is the one the person holding the code
 * could not have predicted.
 */
const refusalFor = (row: InvitationRow, useCount: number, now: Date): string | null => {
    if (row.revokedAt) {
        return "That invitation has been withdrawn";
    }

    if (row.expiresAt && new Date(row.expiresAt) <= now) {
        return "That invitation has expired";
    }

    if (row.maxUses !== null && useCount >= row.maxUses) {
        return "That invitation has already been used";
    }

    return null;
};

const toInvitation = (row: InvitationListRow, now: Date): Invitation => ({
    id: row.id,
    code: row.code,
    label: row.label,
    scopes: parseScopes(row.scopes),
    maxUses: row.maxUses,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    useCount: row.useCount,
    usable: refusalFor(row, row.useCount, now) === null,
});

export const listInvitations = (auth: AuthContext): Invitation[] => {
    requireScope(auth, "admin");

    const now = new Date();

    return invitationRepo.listInvitations().map((row) => toInvitation(row, now));
};

/**
 * Mint one.
 *
 * The code is generated, never supplied — there is no parameter for it and deliberately no
 * way to add one. A code somebody chooses carries whatever entropy went into choosing it,
 * and on an internet-facing deployment that is the difference between a rate limiter that
 * bounds volume and one that is the only thing between a stranger and the library.
 */
export const createInvitation = (input: CreateInvitationInput, auth: AuthContext): Invitation => {
    requireScope(auth, "admin");

    const granting = input.scopes ?? [];
    const beyond = granting.filter((scope) => !auth.scopes.includes(scope));

    if (beyond.length > 0) {
        // Not a NotFoundError: the caller is an administrator asking for something coherent,
        // and hiding the reason would leave them clicking a button that silently does less
        // than it says.
        throw new AuthorizationError(
            `You cannot grant a permission you do not hold: ${beyond.join(", ")}`
        );
    }

    const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const row = insertWithFreshCode({
        label: input.label?.trim() || null,
        scopes: granting.join(","),
        maxUses: input.maxUses ?? null,
        expiresAt,
        createdById: auth.userId,
    });

    return toInvitation({ ...row, useCount: 0, createdByName: auth.displayName }, new Date());
};

/**
 * Insert, retrying on the one-in-a-quadrillion collision rather than reporting it.
 *
 * The code is unique in the schema, so a collision is a constraint violation rather than a
 * silently shared invitation. Retrying is still worth the six lines: the alternative is an
 * error message that can never be acted on, for an event whose correct handling is obviously
 * "draw another one".
 */
const insertWithFreshCode = (
    input: Omit<Parameters<typeof invitationRepo.createInvitation>[0], "code">
): InvitationRow => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateInvitationCode();

        if (!invitationRepo.findByCode(code)) {
            return invitationRepo.createInvitation({ ...input, code });
        }
    }

    throw new ConflictError("Could not generate an unused invitation code");
};

export const revokeInvitation = (id: string, auth: AuthContext): Invitation => {
    requireScope(auth, "admin");

    if (!invitationRepo.findById(id)) {
        throw new NotFoundError("Invitation not found");
    }

    invitationRepo.revokeInvitation(id);

    const row = invitationRepo.listInvitations().find((candidate) => candidate.id === id)!;

    return toInvitation(row, new Date());
};

/**
 * Remove an invitation nobody used.
 *
 * Offered only for one with no accounts behind it, and the repo enforces that in the
 * statement rather than trusting a check here. An invitation somebody joined through is
 * revoked instead: deleting it would throw away the only record of how that account was
 * created.
 */
export const deleteInvitation = (id: string, auth: AuthContext): void => {
    requireScope(auth, "admin");

    if (!invitationRepo.findById(id)) {
        throw new NotFoundError("Invitation not found");
    }

    if (!invitationRepo.deleteUnusedInvitation(id)) {
        throw new ConflictError(
            "Somebody has joined through this invitation. Withdraw it instead, so the record of how they joined survives."
        );
    }
};

/**
 * Check a code on the way in, and say what the account it creates may do.
 *
 * Unauthenticated: this is the one thing on this module a stranger reaches. It does not
 * mark anything used — the use count is derived from the accounts naming the invitation, so
 * "using" it *is* creating the account, and the two cannot come apart.
 *
 * The consequence worth naming: two people submitting the last use of an invitation at the
 * same moment can both pass this check. That is accepted rather than locked against. The
 * window is milliseconds wide, it needs both parties to hold a valid code already, and the
 * outcome is one extra account belonging to somebody who was invited — against a transaction
 * around account creation that would have to hold a write lock on the file the worker is
 * using, for the entire duration of a bcrypt hash at cost 12.
 */
export const consumeInvitation = (code: string): { invitationId: string; scopes: Scope[] } => {
    const row = invitationRepo.findByCode(code);

    // A code that exists but cannot be used says so, rather than being reported as unknown.
    //
    // That does distinguish a real code from an invented one, and it is the right trade here
    // *because the code is generated*: at fifty bits nobody reaches this branch by guessing,
    // so the only person who learns anything is the one holding a code that has expired --
    // who needs to be told exactly that, or they will retype a correct code until they give
    // up. The reasoning does not carry over to the email check in `register`, where the input
    // is a person's address and guessing it is the attack.
    const refusal = row && refusalFor(row, invitationRepo.countUses(row.id), new Date());

    if (!row || refusal) {
        throw new ValidationError(refusal ?? "That invitation code is not valid");
    }

    return { invitationId: row.id, scopes: parseScopes(row.scopes) };
};
