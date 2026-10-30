import {
    AuthenticationError,
    ValidationError,
    type PinStatus,
    type SetPinInput,
    type VerifyPinResult,
} from "@private-stock/core";
import { userRepo } from "@private-stock/db";

import { verifyPassword } from "../auth/password";
import { hashPin, verifyPin as matchPin } from "../auth/pin";
import { logout } from "./authService";

/**
 * The screen lock's PIN (§12c "The screen lock").
 *
 * One per account, kept here; whether a device locks, and after how long, is the device's own
 * choice and never reaches the server. The lock itself is drawn by the browser, so this is not a
 * security boundary — someone with the device and developer tools can step past it. What the
 * server adds is that guessing is bounded: a handful of wrong tries signs the device out, and
 * getting back in takes the password.
 */

/** Wrong tries in a row, across the account's devices, before the one guessing is signed out. */
export const PIN_MAX_MISSES = 5;

/**
 * Misses by account, in memory.
 *
 * Lost on restart, which hands a guesser a fresh five — but restarting the server is not
 * something the person holding the tablet can do. A row would outlive that and buy nothing else.
 */
const misses = new Map<string, number>();

const requireUser = (userId: string) => {
    const user = userRepo.findById(userId);

    if (!user) {
        throw new AuthenticationError("Sign in to continue");
    }

    return user;
};

export const getPinStatus = (userId: string): PinStatus => ({
    set: requireUser(userId).pinHash !== null,
});

/** Set, change or (with `pin: null`) remove the PIN. The password is asked for every time. */
export const setPin = async (userId: string, input: SetPinInput): Promise<PinStatus> => {
    const user = requireUser(userId);

    if (!(await verifyPassword(input.currentPassword, user.password))) {
        // As in `changePassword`: the session is fine, so not an AuthenticationError.
        throw new ValidationError("That is not your current password");
    }

    userRepo.setPin(userId, input.pin === null ? null : await hashPin(input.pin));
    misses.delete(userId);

    return { set: input.pin !== null };
};

/**
 * Answer a PIN from a locked screen.
 *
 * With no PIN on the account the lock has nothing to ask for and lets the device in: removing
 * the PIN took the password, so that is not a way around it.
 *
 * On the last allowed miss the caller's refresh token is revoked — only this device's, not every
 * session on the account — and the route clears its cookie.
 */
export const verifyPin = async (
    userId: string,
    pin: string,
    refreshToken: string | undefined
): Promise<VerifyPinResult> => {
    const user = requireUser(userId);

    if (user.pinHash === null || (await matchPin(pin, user.pinHash))) {
        misses.delete(userId);

        return { ok: true };
    }

    const missed = (misses.get(userId) ?? 0) + 1;

    if (missed >= PIN_MAX_MISSES) {
        misses.delete(userId);
        logout(refreshToken);

        return { ok: false, signedOut: true };
    }

    misses.set(userId, missed);

    return { ok: false, remaining: PIN_MAX_MISSES - missed };
};
