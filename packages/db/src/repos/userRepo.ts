import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * User rows. Prepared statements only — authorization decisions live in the service layer.
 */

export interface UserRow {
    id: string;
    email: string;
    displayName: string;
    password: string;
    scopes: string;
    disabled: 1 | null;
    /** Incremented on every password change; see `setPassword`. */
    tokenEpoch: number;
    /** The invitation this account arrived through; NULL for the first admin (§12c). */
    invitationId: string | null;
    createdAt: string;
    updatedAt: string;
    /** The screen lock's PIN, hashed (§12c); NULL when none is set. */
    pinHash: string | null;
}

/** A row as the admin screen reads it, with the invitation resolved to something readable. */
export interface UserListRow extends UserRow {
    invitationLabel: string | null;
    invitationCode: string | null;
}

export const countUsers = (): number =>
    (db.prepare(`SELECT count(*) AS n FROM "User"`).get() as { n: number }).n;

export const findById = (id: string): UserRow | undefined =>
    db.prepare(`SELECT * FROM "User" WHERE "id" = ?`).get(id) as UserRow | undefined;

/**
 * Email lookup is case-insensitive.
 *
 * People do not reliably reproduce the capitalisation they registered with, and a login
 * that fails because of a capital letter reads as a forgotten password.
 */
export const findByEmail = (email: string): UserRow | undefined =>
    db.prepare(`SELECT * FROM "User" WHERE "email" = ? COLLATE NOCASE`).get(email) as
        UserRow | undefined;

/**
 * Every account, oldest first.
 *
 * Unpaginated on purpose. This is a household, not a tenant directory — §12c describes a
 * handful of accounts — and a `Pagination` control under a list of three would be furniture.
 * If that assumption ever breaks it breaks visibly, which is better than a limit nobody can
 * see truncating the list of who can reach the library.
 *
 * The password hash is in `UserRow` and therefore in what this returns; the service maps it
 * away before anything leaves the process.
 */
export const listUsers = (): UserListRow[] =>
    db
        .prepare(
            `SELECT u.*, i."label" AS "invitationLabel", i."code" AS "invitationCode"
               FROM "User" u
               LEFT JOIN "Invitation" i ON i."id" = u."invitationId"
              ORDER BY u."createdAt" ASC`
        )
        .all() as UserListRow[];

/** How many accounts hold a given scope, for the service's "not the last admin" check. */
export const countWithScope = (scope: string): number =>
    (
        db
            .prepare(
                `SELECT count(*) AS n
                   FROM "User"
                  WHERE "disabled" IS NULL
                    AND (',' || "scopes" || ',') LIKE ('%,' || ? || ',%')`
            )
            .get(scope) as { n: number }
    ).n;

export interface CreateUserInput {
    email: string;
    displayName: string;
    passwordHash: string;
    scopes: string;
    /** The invitation used, or null for the first admin, who predates every invitation. */
    invitationId?: string | null;
}

export const createUser = (input: CreateUserInput): UserRow => {
    const id = randomUUID();

    db.prepare(
        `INSERT INTO "User"
             ("id", "email", "displayName", "password", "scopes", "invitationId", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
        id,
        input.email,
        input.displayName,
        input.passwordHash,
        input.scopes,
        input.invitationId ?? null
    );

    return findById(id)!;
};

/**
 * Replace an account's scopes.
 *
 * The epoch is deliberately **not** bumped. Scopes are read from the `User` row on every
 * request rather than trusted from the access token, so a change takes effect on the next
 * request without anything being revoked — and bumping the epoch would invalidate every
 * signed media URL the person is holding, stopping playback mid-item to grant them something.
 */
export const setScopes = (id: string, scopes: string): void => {
    db.prepare(
        `UPDATE "User" SET "scopes" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(scopes, id);
};

/**
 * Disable or re-enable an account.
 *
 * Stored as 1 or NULL, never 0, per the schema convention — the partial index depends on it.
 *
 * Disabling bumps the epoch, which is the opposite of the reasoning above and for the same
 * underlying reason: taking access away has to reach the signed media URLs already issued,
 * or a disabled account goes on streaming until each one expires. Re-enabling bumps it too,
 * which costs nothing — there is nothing valid outstanding to invalidate.
 */
export const setDisabled = (id: string, disabled: boolean): void => {
    db.prepare(
        `UPDATE "User"
            SET "disabled" = ?,
                "tokenEpoch" = "tokenEpoch" + 1,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(disabled ? 1 : null, id);
};

/**
 * Remove an account and everything that belonged to it.
 *
 * The cascades do the work: ratings, watch state, private tags and their assignments, saved
 * views, playlists, preferences and refresh tokens all name `User` with ON DELETE CASCADE.
 * What deliberately survives is the catalogue — media, public tags and shared playlists are
 * the library's, not the account's, and `createdById` is ON DELETE SET NULL so a shared thing
 * loses its attribution rather than itself.
 */
export const deleteUser = (id: string): void => {
    db.prepare(`DELETE FROM "User" WHERE "id" = ?`).run(id);
};

/**
 * Change the name an account is known by, the address it signs in with, or both.
 *
 * The epoch is deliberately **not** bumped, and neither are sessions revoked. Nothing about
 * identity has changed: the same person holds the same account, and the signed media URLs in
 * their hands still name the same `sub`. Ending their sessions because an administrator fixed
 * a typo in their address would be a puzzling sign-out with no cause they could see.
 *
 * Email uniqueness is the schema's (`UNIQUE` on the column), so a collision arrives here as a
 * constraint violation; the service checks first so it can say which address is taken.
 */
export const setProfile = (id: string, patch: { displayName?: string; email?: string }): void => {
    // Built rather than written out, because an UPDATE naming a column the caller did not ask
    // about would overwrite it with whatever was read a moment ago -- and "a moment ago" is
    // long enough for the person themselves to have changed it.
    const assignments: string[] = [];
    const values: Record<string, string> = {};

    if (patch.displayName !== undefined) {
        assignments.push(`"displayName" = :displayName`);
        values.displayName = patch.displayName;
    }

    if (patch.email !== undefined) {
        assignments.push(`"email" = :email`);
        values.email = patch.email;
    }

    if (assignments.length === 0) {
        return;
    }

    db.prepare(
        `UPDATE "User"
            SET ${assignments.join(", ")}, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = :id`
    ).run({ ...values, id });
};

/**
 * Change a password and invalidate everything minted under the old one.
 *
 * The epoch bump is part of the same statement rather than a second call, because the two
 * must not be able to come apart: a password changed without it would leave signed media
 * tokens (§12d) working for up to a day, which is exactly the window someone changing their
 * password is trying to close.
 */
export const setPassword = (id: string, passwordHash: string): void => {
    db.prepare(
        `UPDATE "User"
            SET "password" = ?,
                "tokenEpoch" = "tokenEpoch" + 1,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(passwordHash, id);
};

/**
 * Set or clear the screen lock's PIN.
 *
 * Neither the epoch nor any session is touched: the PIN unlocks a screen this device is already
 * signed in on, and is no credential for anything the server hands out.
 */
export const setPin = (id: string, pinHash: string | null): void => {
    db.prepare(
        `UPDATE "User" SET "pinHash" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(pinHash, id);
};
