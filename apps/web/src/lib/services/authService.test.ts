import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError, ValidationError } from "@private-stock/core";

/**
 * Changing a password (§12d).
 *
 * The claim worth proving is that one action closes every door at once. A password change
 * that revoked sessions but left signed media URLs alive — or bumped the epoch but left
 * refresh tokens alive — would look like it worked while leaving open the exact thing the
 * user was trying to shut.
 */

let stored: { id: string; password: string; tokenEpoch: number } | undefined;
let revokedAllFor: string[] = [];
/** Every refresh token issued, in order, and whether a later revocation reached it. */
let issued: { userId: string; token: string; revoked: boolean }[] = [];

vi.mock("@private-stock/db", () => ({
    userRepo: {
        findById: (id: string) => (stored?.id === id ? stored : undefined),
        findByEmail: () => undefined,
        // Mirrors the real statement, which bumps the epoch in the same UPDATE.
        setPassword: (id: string, hash: string) => {
            if (stored?.id === id) {
                stored = { ...stored, password: hash, tokenEpoch: stored.tokenEpoch + 1 };
            }
        },
    },
    refreshTokenRepo: {
        revokeAllForUser: (userId: string) => {
            revokedAllFor.push(userId);
            for (const token of issued) {
                if (token.userId === userId) token.revoked = true;
            }
        },
        issue: (userId: string) => {
            const token = `token-${issued.length + 1}`;
            issued.push({ userId, token, revoked: false });
            return { token, expiresAt: new Date("2027-01-01T00:00:00Z") };
        },
    },
}));

const { changePassword } = await import("./authService");
const { hashPassword, verifyPassword } = await import("../auth/password");

const USER = "user-1";
const CURRENT = "correct horse battery";

beforeEach(async () => {
    stored = { id: USER, password: await hashPassword(CURRENT), tokenEpoch: 4 };
    revokedAllFor = [];
    issued = [{ userId: USER, token: "token-0", revoked: false }];
});

describe("changing a password", () => {
    it("replaces the hash", async () => {
        await changePassword(
            USER,
            { currentPassword: CURRENT, newPassword: "a new long one" },
            null
        );

        expect(await verifyPassword("a new long one", stored!.password)).toBe(true);
        expect(await verifyPassword(CURRENT, stored!.password)).toBe(false);
    });

    it("advances the epoch, which is what kills outstanding signed URLs", async () => {
        await changePassword(
            USER,
            { currentPassword: CURRENT, newPassword: "a new long one" },
            null
        );

        expect(stored!.tokenEpoch).toBe(5);
    });

    it("revokes every refresh token on the account", async () => {
        await changePassword(
            USER,
            { currentPassword: CURRENT, newPassword: "a new long one" },
            null
        );

        expect(revokedAllFor).toEqual([USER]);
    });

    /**
     * Every *other* session ends; the one that asked is handed a new token minted after the
     * revocation. Keeping only its access token signed the person out fifteen minutes later,
     * from the tab they had just used to secure the account.
     */
    it("keeps the device that asked signed in, and only that one", async () => {
        const kept = await changePassword(
            USER,
            { currentPassword: CURRENT, newPassword: "a new long one" },
            null
        );

        const live = issued.filter((token) => !token.revoked);

        expect(live.map((token) => token.token)).toEqual([kept.refreshToken]);
        expect(issued.find((token) => token.token === "token-0")!.revoked).toBe(true);
    });

    it("issues nothing when the current password is wrong", async () => {
        await expect(
            changePassword(USER, { currentPassword: "wrong", newPassword: "a new long one" }, null)
        ).rejects.toThrow(ValidationError);

        expect(issued).toEqual([{ userId: USER, token: "token-0", revoked: false }]);
    });

    /**
     * The current password is required even though the request is authenticated.
     *
     * It is what stops a borrowed session — an unlocked laptop, a stolen access token — from
     * being turned into permanent ownership of the account.
     */
    /**
     * bcrypt stops reading at 72 bytes. Seventy characters of `é` are 140 of them, and every
     * password sharing the first half would have matched the hash.
     */
    it("refuses a password bcrypt would truncate, and changes nothing", async () => {
        await expect(
            changePassword(USER, { currentPassword: CURRENT, newPassword: "é".repeat(70) }, null)
        ).rejects.toThrow(ValidationError);

        expect(revokedAllFor).toEqual([]);
        expect(stored!.tokenEpoch).toBe(4);
    });

    it("refuses without the current password", async () => {
        await expect(
            changePassword(USER, { currentPassword: "wrong", newPassword: "a new long one" }, null)
        ).rejects.toThrow(ValidationError);

        expect(revokedAllFor).toEqual([]);
        expect(stored!.tokenEpoch).toBe(4);
    });

    /**
     * A wrong current password is a validation failure, not an authentication one.
     *
     * The session is perfectly valid. Answering with `AuthenticationError` would have the
     * client discard a good token and send the user to a login page, which reads as being
     * logged out for typing a password wrong.
     */
    it("does not report a wrong current password as a dead session", async () => {
        await expect(
            changePassword(USER, { currentPassword: "wrong", newPassword: "a new long one" }, null)
        ).rejects.not.toThrow(AuthenticationError);
    });

    it("refuses for an account that no longer exists", async () => {
        stored = undefined;

        await expect(
            changePassword(USER, { currentPassword: CURRENT, newPassword: "a new long one" }, null)
        ).rejects.toThrow(AuthenticationError);
    });
});
