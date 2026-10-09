import { createHash, randomBytes, randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * Refresh tokens.
 *
 * Only the hash is stored. A refresh token is a long-lived credential, so a database backup
 * or a stray `SELECT *` should not hand someone a working session — the same reasoning that
 * applies to passwords. SHA-256 rather than bcrypt is right here: the token is 32 bytes of
 * CSPRNG output, so there is no dictionary to attack and the cost of a slow hash on every
 * refresh buys nothing.
 */

export interface RefreshTokenRow {
    id: string;
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    expiresAt: string;
    lastSeenAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    /** Set with `revokedAt` when a refresh replaced this token; null for any other revoke. */
    rotatedAt: string | null;
}

export const hashToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

export interface IssuedToken {
    token: string;
    expiresAt: Date;
}

export const issue = (userId: string, ttlDays: number, userAgent?: string | null): IssuedToken => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    db.prepare(
        `INSERT INTO "RefreshToken" ("id", "userId", "tokenHash", "userAgent", "expiresAt")
         VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), userId, hashToken(token), userAgent ?? null, expiresAt.toISOString());

    return { token, expiresAt };
};

/** Live means: exists, not revoked, not expired. */
export const findLive = (token: string): RefreshTokenRow | undefined =>
    db
        .prepare(
            `SELECT * FROM "RefreshToken"
              WHERE "tokenHash" = ?
                AND "revokedAt" IS NULL
                AND "expiresAt" > CURRENT_TIMESTAMP`
        )
        .get(hashToken(token)) as RefreshTokenRow | undefined;

/**
 * A token a refresh replaced within the last `graceSeconds`, and not revoked for any other
 * reason since.
 *
 * The grace exists because the cookie is shared and the rotation is not. Two tabs reloading
 * together send the same token and only the first rotates it; a reload that aborts a refresh
 * the server has already finished leaves the browser holding the token that was just replaced.
 * Without a window, both are signed out — which is what happened on every code change in
 * development, where reloads come in pairs.
 *
 * Only `rotatedAt` opens the window. Signing out and changing a password clear it (`revoke`,
 * `revokeAllForUser`), so neither can be undone by replaying an older token.
 */
export const findRecentlyRotated = (
    token: string,
    graceSeconds: number
): RefreshTokenRow | undefined =>
    db
        .prepare(
            `SELECT * FROM "RefreshToken"
              WHERE "tokenHash" = ?
                AND "rotatedAt" IS NOT NULL
                AND "rotatedAt" >= datetime('now', ?)
                AND "expiresAt" > CURRENT_TIMESTAMP`
        )
        .get(hashToken(token), `-${Math.floor(graceSeconds)} seconds`) as
        RefreshTokenRow | undefined;

/**
 * Replace a live token with a new one, in one transaction.
 *
 * It was two autocommit statements, so a busy database between them — the worker holding the
 * write lock — could revoke the old token and fail to issue the new one, leaving the person
 * with neither. Returns null when the token was no longer live by the time the write ran, so
 * two rotations of the same token cannot both succeed.
 */
export const rotate = (
    token: string,
    userId: string,
    ttlDays: number,
    userAgent?: string | null
): IssuedToken | null =>
    db.transaction(() => {
        const changed = db
            .prepare(
                `UPDATE "RefreshToken"
                    SET "revokedAt" = CURRENT_TIMESTAMP, "rotatedAt" = CURRENT_TIMESTAMP
                  WHERE "tokenHash" = ? AND "revokedAt" IS NULL`
            )
            .run(hashToken(token)).changes;

        return changed > 0 ? issue(userId, ttlDays, userAgent) : null;
    })();

export const touch = (id: string): void => {
    db.prepare(`UPDATE "RefreshToken" SET "lastSeenAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(id);
};

/**
 * Sign one session out.
 *
 * Also closes the rotation grace on every token of the account. The token being signed out is
 * the newest in its chain, and the one it replaced a moment ago is still inside the window —
 * left open, replaying it would sign straight back in. Closing it account-wide rather than
 * along the chain costs at most a second sign-in on another device that happened to be
 * mid-refresh in the same few seconds.
 */
export const revoke = (token: string): void => {
    db.transaction(() => {
        const row = db
            .prepare(`SELECT "userId" FROM "RefreshToken" WHERE "tokenHash" = ?`)
            .get(hashToken(token)) as { userId: string } | undefined;

        db.prepare(
            `UPDATE "RefreshToken"
                SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP), "rotatedAt" = NULL
              WHERE "tokenHash" = ?`
        ).run(hashToken(token));

        if (row) {
            db.prepare(
                `UPDATE "RefreshToken" SET "rotatedAt" = NULL
                  WHERE "userId" = ? AND "rotatedAt" IS NOT NULL`
            ).run(row.userId);
        }
    })();
};

/** Every session on the account, including any token still inside the rotation grace. */
export const revokeAllForUser = (userId: string): void => {
    db.prepare(
        `UPDATE "RefreshToken"
            SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP), "rotatedAt" = NULL
          WHERE "userId" = ? AND ("revokedAt" IS NULL OR "rotatedAt" IS NOT NULL)`
    ).run(userId);
};

export const listForUser = (userId: string): RefreshTokenRow[] =>
    db
        .prepare(
            `SELECT * FROM "RefreshToken"
              WHERE "userId" = ? AND "revokedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP
              ORDER BY "lastSeenAt" DESC NULLS LAST, "createdAt" DESC`
        )
        .all(userId) as RefreshTokenRow[];

/** Housekeeping: expired and revoked rows are not evidence of anything. */
export const purgeExpired = (): number =>
    db
        .prepare(
            `DELETE FROM "RefreshToken"
              WHERE "expiresAt" < CURRENT_TIMESTAMP
                 OR ("revokedAt" IS NOT NULL AND "revokedAt" < datetime('now', '-30 days'))`
        )
        .run().changes;
