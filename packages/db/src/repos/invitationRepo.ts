import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * Invitation rows (§12c). Prepared statements only — every decision about whether an
 * invitation may be used lives in `invitationService`.
 *
 * The one thing worth knowing about the shape: **nothing here stores a use count.** Uses are
 * counted by asking how many `User` rows name the invitation, every time. A stored counter is
 * a second source of truth that can disagree with the accounts it claims to describe — and
 * the disagreement would show up as either an invitation that has quietly stopped working or
 * one that admits more people than it was given.
 */

export interface InvitationRow {
    id: string;
    code: string;
    label: string | null;
    scopes: string;
    maxUses: number | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdById: string | null;
    createdAt: string;
}

/** An invitation as the admin screen reads it: the row, plus the two derived facts. */
export interface InvitationListRow extends InvitationRow {
    useCount: number;
    /** Display name of whoever minted it, or NULL if that account is gone. */
    createdByName: string | null;
}

const USE_COUNT = `(SELECT count(*) FROM "User" u WHERE u."invitationId" = i."id")`;

export const listInvitations = (): InvitationListRow[] =>
    db
        .prepare(
            `SELECT i.*, ${USE_COUNT} AS "useCount", c."displayName" AS "createdByName"
               FROM "Invitation" i
               LEFT JOIN "User" c ON c."id" = i."createdById"
              -- Live ones first, then by age. A revoked invitation is kept for the record
              -- rather than for use, so it belongs at the bottom.
              ORDER BY (i."revokedAt" IS NOT NULL), i."createdAt" DESC`
        )
        .all() as InvitationListRow[];

export const findById = (id: string): InvitationRow | undefined =>
    db.prepare(`SELECT * FROM "Invitation" WHERE "id" = ?`).get(id) as InvitationRow | undefined;

/**
 * Look up by the canonical code.
 *
 * Case-sensitive and exact: the caller normalises first (`normalizeInvitationCode`), and the
 * stored form went through the same function. Forgiving the typed form in one place and
 * comparing exactly in the other is what keeps "which spellings are the same code" from
 * having two answers.
 */
export const findByCode = (code: string): InvitationRow | undefined =>
    db.prepare(`SELECT * FROM "Invitation" WHERE "code" = ?`).get(code) as
        InvitationRow | undefined;

export const countUses = (id: string): number =>
    (
        db.prepare(`SELECT count(*) AS n FROM "User" WHERE "invitationId" = ?`).get(id) as {
            n: number;
        }
    ).n;

export interface NewInvitationInput {
    code: string;
    label: string | null;
    scopes: string;
    maxUses: number | null;
    /** ISO string, or null for an invitation that never expires. */
    expiresAt: string | null;
    createdById: string;
}

export const createInvitation = (input: NewInvitationInput): InvitationRow => {
    const id = randomUUID();

    db.prepare(
        `INSERT INTO "Invitation"
             ("id", "code", "label", "scopes", "maxUses", "expiresAt", "createdById")
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        input.code,
        input.label,
        input.scopes,
        input.maxUses,
        input.expiresAt,
        input.createdById
    );

    return findById(id)!;
};

/**
 * Stop an invitation working, keeping the row.
 *
 * Idempotent by way of the `IS NULL` guard: revoking twice leaves the first timestamp alone,
 * so the recorded answer to "when did this stop working" does not move when somebody clicks
 * the button again.
 */
export const revokeInvitation = (id: string): void => {
    db.prepare(
        `UPDATE "Invitation"
            SET "revokedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "revokedAt" IS NULL`
    ).run(id);
};

/**
 * Delete an invitation nobody has used.
 *
 * The `NOT EXISTS` clause is in the statement rather than checked first, because the check and
 * the delete would otherwise be two steps with a registration able to land between them — and
 * the result would be an account whose `invitationId` had been set to NULL by the foreign key,
 * silently losing the record of how it was created. Revoking is the ordinary path; this exists
 * for tidying away a code that was minted by mistake.
 */
export const deleteUnusedInvitation = (id: string): boolean =>
    db
        .prepare(
            `DELETE FROM "Invitation"
              WHERE "id" = ?
                AND NOT EXISTS (SELECT 1 FROM "User" WHERE "invitationId" = "Invitation"."id")`
        )
        .run(id).changes > 0;
