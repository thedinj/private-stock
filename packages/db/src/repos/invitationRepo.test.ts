import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Invitation rows, against a real database (§12c).
 *
 * The property most of these exist to pin down is that **a use count is derived, never
 * stored**: every question about how many people have used an invitation is answered by
 * counting the accounts that name it. A stored counter would be a second source of truth, and
 * the two disagreeing would show up either as an invitation that quietly stopped working or
 * one that let in more people than it was given.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const invitationRepo = await import("./invitationRepo.js");
const userRepo = await import("./userRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADMIN = "u-admin";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`DELETE FROM "User"; DELETE FROM "Invitation";`);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
         VALUES (?, 'admin@example.test', 'The Admin', 'x', 'admin,delete', CURRENT_TIMESTAMP)`
    ).run(ADMIN);
});

const mint = (over: Partial<invitationRepo.NewInvitationInput> = {}) =>
    invitationRepo.createInvitation({
        code: "ABCDEFGHJK",
        label: "Houseguests",
        scopes: "",
        maxUses: null,
        expiresAt: null,
        createdById: ADMIN,
        ...over,
    });

const joinVia = (invitationId: string | null, email: string) =>
    userRepo.createUser({
        email,
        displayName: email.split("@")[0],
        passwordHash: "x",
        scopes: "",
        invitationId,
    });

describe("minting", () => {
    it("stores what it was given", () => {
        const row = mint({ maxUses: 5, scopes: "delete", expiresAt: "2030-01-01T00:00:00.000Z" });

        expect(row.code).toBe("ABCDEFGHJK");
        expect(row.label).toBe("Houseguests");
        expect(row.scopes).toBe("delete");
        expect(row.maxUses).toBe(5);
        expect(row.expiresAt).toBe("2030-01-01T00:00:00.000Z");
        expect(row.revokedAt).toBeNull();
        expect(row.createdById).toBe(ADMIN);
    });

    it("refuses a second invitation with the same code", () => {
        mint();

        expect(() => mint()).toThrow(/UNIQUE/i);
    });

    /** Codes are compared exactly, because both sides went through normalisation first. */
    it("finds by the exact stored code and not by a variant", () => {
        mint();

        expect(invitationRepo.findByCode("ABCDEFGHJK")?.label).toBe("Houseguests");
        expect(invitationRepo.findByCode("abcdefghjk")).toBeUndefined();
        expect(invitationRepo.findByCode("ABCDE-FGHJK")).toBeUndefined();
    });
});

describe("use counting", () => {
    it("counts nobody before anybody joins", () => {
        expect(invitationRepo.countUses(mint().id)).toBe(0);
    });

    it("counts the accounts that name it", () => {
        const invitation = mint();

        joinVia(invitation.id, "a@example.test");
        joinVia(invitation.id, "b@example.test");

        expect(invitationRepo.countUses(invitation.id)).toBe(2);
    });

    it("does not count an account that arrived some other way", () => {
        const invitation = mint();

        joinVia(null, "first-admin@example.test");
        joinVia(mint({ code: "ZZZZZZZZZZ" }).id, "elsewhere@example.test");

        expect(invitationRepo.countUses(invitation.id)).toBe(0);
    });

    /**
     * The count follows the accounts, so deleting one gives the use back. That is the right
     * behaviour and the reason it is derived: a stored counter would leave a five-use
     * invitation permanently spent by somebody who was removed the same afternoon.
     */
    it("gives a use back when the account is deleted", () => {
        const invitation = mint({ maxUses: 2 });
        const user = joinVia(invitation.id, "a@example.test");

        expect(invitationRepo.countUses(invitation.id)).toBe(1);

        userRepo.deleteUser(user.id);

        expect(invitationRepo.countUses(invitation.id)).toBe(0);
    });
});

describe("revoking", () => {
    it("stamps a time without removing the row", () => {
        const invitation = mint();

        invitationRepo.revokeInvitation(invitation.id);

        expect(invitationRepo.findById(invitation.id)?.revokedAt).toBeTruthy();
    });

    /** "When did this stop working" must not move because somebody clicked twice. */
    it("keeps the first timestamp when revoked again", () => {
        const invitation = mint();

        invitationRepo.revokeInvitation(invitation.id);
        const first = invitationRepo.findById(invitation.id)!.revokedAt;

        invitationRepo.revokeInvitation(invitation.id);

        expect(invitationRepo.findById(invitation.id)?.revokedAt).toBe(first);
    });

    it("keeps the accounts that used it", () => {
        const invitation = mint();
        joinVia(invitation.id, "a@example.test");

        invitationRepo.revokeInvitation(invitation.id);

        expect(invitationRepo.countUses(invitation.id)).toBe(1);
    });
});

describe("deleting an unused invitation", () => {
    it("removes one nobody has used", () => {
        const invitation = mint();

        expect(invitationRepo.deleteUnusedInvitation(invitation.id)).toBe(true);
        expect(invitationRepo.findById(invitation.id)).toBeUndefined();
    });

    /**
     * The guard is inside the statement so a registration cannot land between a check and a
     * delete. If it could, the foreign key would set the new account's `invitationId` to NULL
     * and the record of how it was created would be gone with no error anywhere.
     */
    it("refuses one that has been used, and leaves it alone", () => {
        const invitation = mint();
        joinVia(invitation.id, "a@example.test");

        expect(invitationRepo.deleteUnusedInvitation(invitation.id)).toBe(false);
        expect(invitationRepo.findById(invitation.id)).toBeDefined();
    });

    it("reports nothing deleted for an id that does not exist", () => {
        expect(invitationRepo.deleteUnusedInvitation("nope")).toBe(false);
    });
});

describe("listing", () => {
    it("resolves the use count and who minted it", () => {
        const invitation = mint({ maxUses: 3 });
        joinVia(invitation.id, "a@example.test");

        const [row] = invitationRepo.listInvitations();

        expect(row.useCount).toBe(1);
        expect(row.createdByName).toBe("The Admin");
    });

    /** A revoked invitation is kept for the record rather than for use, so it sinks. */
    it("puts live invitations before revoked ones", () => {
        const first = mint({ code: "AAAAAAAAAA", label: "revoked" });
        mint({ code: "BBBBBBBBBB", label: "live" });
        invitationRepo.revokeInvitation(first.id);

        expect(invitationRepo.listInvitations().map((row) => row.label)).toEqual([
            "live",
            "revoked",
        ]);
    });

    /**
     * `createdById` is ON DELETE SET NULL, so removing the admin who minted an invitation
     * loses the attribution rather than the invitation.
     */
    it("survives the account that minted it being deleted", () => {
        mint();

        userRepo.deleteUser(ADMIN);

        const [row] = invitationRepo.listInvitations();
        expect(row.createdByName).toBeNull();
        expect(row.code).toBe("ABCDEFGHJK");
    });
});

describe("the account list", () => {
    it("resolves the invitation each account arrived through", () => {
        const invitation = mint({ label: "Mum" });
        joinVia(invitation.id, "mum@example.test");

        const row = userRepo.listUsers().find((u) => u.email === "mum@example.test")!;

        expect(row.invitationLabel).toBe("Mum");
        expect(row.invitationCode).toBe("ABCDEFGHJK");
    });

    /** The first admin predates every invitation, so it has none rather than a broken one. */
    it("leaves the first admin without an invitation", () => {
        const row = userRepo.listUsers().find((u) => u.id === ADMIN)!;

        expect(row.invitationId).toBeNull();
        expect(row.invitationLabel).toBeNull();
    });

    it("counts accounts holding a scope, ignoring disabled ones", () => {
        expect(userRepo.countWithScope("admin")).toBe(1);

        const second = joinVia(mint().id, "second@example.test");
        userRepo.setScopes(second.id, "admin,delete");

        expect(userRepo.countWithScope("admin")).toBe(2);

        userRepo.setDisabled(second.id, true);

        expect(userRepo.countWithScope("admin")).toBe(1);
    });

    /**
     * The scope match is on a comma-delimited column, so it must not match a substring:
     * neither "delete" inside "undelete" nor "admin" inside "admins".
     *
     * The seeded admin holds both real scopes, so the counts below stay at one throughout --
     * the assertion is that the second account, holding only lookalikes, is never counted.
     */
    it("does not match a scope that is a substring of another", () => {
        expect(userRepo.countWithScope("delete")).toBe(1);
        expect(userRepo.countWithScope("admin")).toBe(1);

        const second = joinVia(mint().id, "second@example.test");
        userRepo.setScopes(second.id, "undelete,admins");

        expect(userRepo.countWithScope("delete")).toBe(1);
        expect(userRepo.countWithScope("admin")).toBe(1);
    });
});
