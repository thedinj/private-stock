import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Hashing the screen lock's PIN (§12c).
 *
 * **Not bcrypt**, unlike the password. `bcryptjs` is pure JavaScript and holds the one thread
 * that serves every request for one to five seconds on the NAS (`password.ts`), which is a price
 * for signing in and not for unlocking a tablet. Node's `scrypt` runs on the libuv pool, so an
 * unlock costs the event loop nothing.
 *
 * Nor is it tuned to resist offline guessing: a PIN of four to eight digits falls to any hash
 * once the hash is out. What holds the line is that the server answers only a handful of wrong
 * tries before it signs the device out (`pinService`).
 */
const KEY_LENGTH = 32;
const COST = 16384;

const derive = (pin: string, salt: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        scrypt(pin, salt, KEY_LENGTH, { N: COST }, (error, key) =>
            error ? reject(error) : resolve(key)
        );
    });

/** `scrypt$<salt>$<key>`, both base64. */
export const hashPin = async (pin: string): Promise<string> => {
    const salt = randomBytes(16);
    const key = await derive(pin, salt);

    return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
};

export const verifyPin = async (pin: string, stored: string): Promise<boolean> => {
    const [scheme, salt, key] = stored.split("$");

    if (scheme !== "scrypt" || !salt || !key) {
        return false;
    }

    const expected = Buffer.from(key, "base64");
    const actual = await derive(pin, Buffer.from(salt, "base64"));

    return actual.length === expected.length && timingSafeEqual(actual, expected);
};
