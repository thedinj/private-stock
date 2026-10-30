import { beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "@private-stock/core";

/**
 * The screen lock's PIN (§12c).
 *
 * What has to hold: the password is needed to set one, a right PIN answers yes, and wrong ones
 * run out — ending this device's session and nobody else's.
 */

let stored: { id: string; password: string; pinHash: string | null } | undefined;
let revoked: string[] = [];

vi.mock("@private-stock/db", () => ({
    userRepo: {
        findById: (id: string) => (stored?.id === id ? stored : undefined),
        setPin: (id: string, pinHash: string | null) => {
            if (stored?.id === id) {
                stored = { ...stored, pinHash };
            }
        },
    },
    refreshTokenRepo: {
        revoke: (token: string) => revoked.push(token),
    },
}));

const { PIN_MAX_MISSES, getPinStatus, setPin, verifyPin } = await import("./pinService");
const { hashPassword } = await import("../auth/password");

const USER = "user-1";
const PASSWORD = "correct horse battery";

beforeEach(async () => {
    stored = { id: USER, password: await hashPassword(PASSWORD), pinHash: null };
    revoked = [];
});

describe("setting a PIN", () => {
    it("needs the password", async () => {
        await expect(setPin(USER, { currentPassword: "wrong", pin: "1234" })).rejects.toThrow(
            ValidationError
        );
        expect(getPinStatus(USER)).toEqual({ set: false });
    });

    it("stores a hash, not the PIN, and can be removed", async () => {
        await setPin(USER, { currentPassword: PASSWORD, pin: "1234" });
        expect(stored?.pinHash).toMatch(/^scrypt\$/);
        expect(stored?.pinHash).not.toContain("1234");
        expect(getPinStatus(USER)).toEqual({ set: true });

        await setPin(USER, { currentPassword: PASSWORD, pin: null });
        expect(getPinStatus(USER)).toEqual({ set: false });
    });
});

describe("unlocking", () => {
    beforeEach(async () => {
        await setPin(USER, { currentPassword: PASSWORD, pin: "2468" });
    });

    it("accepts the right PIN", async () => {
        expect(await verifyPin(USER, "2468", "cookie")).toEqual({ ok: true });
    });

    it("counts down wrong tries, and a right one resets the count", async () => {
        expect(await verifyPin(USER, "0000", "cookie")).toEqual({
            ok: false,
            remaining: PIN_MAX_MISSES - 1,
        });
        await verifyPin(USER, "2468", "cookie");
        expect(await verifyPin(USER, "0000", "cookie")).toEqual({
            ok: false,
            remaining: PIN_MAX_MISSES - 1,
        });
    });

    it("signs this device out on the last wrong try", async () => {
        for (let i = 1; i < PIN_MAX_MISSES; i += 1) {
            await verifyPin(USER, "0000", "this-device");
        }

        expect(await verifyPin(USER, "0000", "this-device")).toEqual({
            ok: false,
            signedOut: true,
        });
        expect(revoked).toEqual(["this-device"]);
    });

    it("lets a device in once the PIN has been removed", async () => {
        await setPin(USER, { currentPassword: PASSWORD, pin: null });
        expect(await verifyPin(USER, "anything", "cookie")).toEqual({ ok: true });
    });
});
