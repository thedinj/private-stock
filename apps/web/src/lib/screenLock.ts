/**
 * The screen lock's device-side state (§12c "The screen lock").
 *
 * The PIN is the account's and lives on the server; whether *this device* locks, and after how
 * long, is the device's and lives here. Keyed by account, so a tablet two people share can lock
 * for one of them and not the other.
 *
 * Three keys per account:
 *
 *   - the setting itself, present only while the lock is on;
 *   - when somebody last used the app, shared by every tab, so reading in one tab keeps the
 *     others awake and a reload after an hour away opens locked;
 *   - whether it is locked now, so a reload cannot step past the lock and locking one tab
 *     locks all of them (each tab listens for the `storage` event).
 *
 * Every access is wrapped, as `playbackPrefs.ts` explains: storage that throws degrades to the
 * lock being off, which is the default anyway.
 */

/** The choices offered, in minutes. An hour is the default. */
export const LOCK_AFTER_MINUTES = [5, 15, 30, 60, 120, 240] as const;
export const DEFAULT_LOCK_AFTER_MINUTES = 60;

const settingKey = (userId: string) => `ps:screenLock:${userId}`;
export const activeAtKey = (userId: string) => `ps:screenLock:${userId}:activeAt`;
export const lockedKey = (userId: string) => `ps:screenLock:${userId}:locked`;

const read = (key: string): string | null => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const write = (key: string, value: string | null): void => {
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
    } catch {
        // Nowhere to keep it; the lock behaves as if it were off.
    }
};

/** Minutes until this device locks, or null when the lock is off here. */
export const readLockAfter = (userId: string): number | null => {
    const minutes = Number(read(settingKey(userId)));

    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
};

export const writeLockAfter = (userId: string, minutes: number | null): void => {
    write(settingKey(userId), minutes === null ? null : String(minutes));

    if (minutes === null) {
        write(lockedKey(userId), null);
    }
};

/** When the app was last used here; null if never recorded. */
export const readActiveAt = (userId: string): number | null => {
    const at = Number(read(activeAtKey(userId)));

    return Number.isFinite(at) && at > 0 ? at : null;
};

export const markActive = (userId: string, at = Date.now()): void => {
    write(activeAtKey(userId), String(at));
};

export const readLocked = (userId: string): boolean => read(lockedKey(userId)) === "1";

export const writeLocked = (userId: string, locked: boolean): void => {
    write(lockedKey(userId), locked ? "1" : null);
};

/**
 * Signing in with the password is a stronger proof than the PIN, so it opens the lock: without
 * this, a device signed out by too many wrong PINs would ask for the PIN again straight after
 * the password.
 */
export const clearLockOnSignIn = (userId: string): void => {
    writeLocked(userId, false);
    markActive(userId);
};
