import { createHash } from "node:crypto";

import type { AuthContext } from "./withAuth";

/**
 * Who a request is, remembered briefly (§20).
 *
 * Authenticating by cookie cost four synchronous statements — the refresh token, the user, and
 * two for the accessible roots — and `<img>` and `<video>` can authenticate no other way, so a
 * grid of sixty covers ran 240 of them on the one thread that serves everything. On the NAS, with
 * the page cache under pressure, single statements in that set measured 300 ms and more.
 *
 * This trades away one thing, knowingly: a change made **outside the web process** — a database
 * edited by hand, a refresh token that rotated out — is seen up to `TTL_MS` late. The owner
 * accepted that in exchange for the reads. Every change made *through* the app still takes
 * effect at once, because the services that make them call `forgetAuth()`: sign-out, password
 * changes, an admin editing, disabling or deleting a user, and a library being added, removed,
 * enabled or disabled.
 *
 * Failures are never cached. An unknown token or a disabled account is re-checked on every
 * request, so nothing here can be filled by someone presenting garbage, and nothing stops a
 * repaired account from working.
 */

const TTL_MS = 60_000;

/**
 * Entries per map, oldest dropped first. Far above the handful of people this serves, and
 * small enough that a stream of distinct valid sessions cannot grow the heap without bound.
 */
const MAX_ENTRIES = 1_000;

interface Entry<T> {
    value: T;
    expiresAt: number;
}

/** Refresh-token hash → user id. Hashed so the heap never holds a usable credential. */
const sessions = new Map<string, Entry<string>>();
/** User id → the authorization state `contextFor` builds. */
const contexts = new Map<string, Entry<AuthContext>>();

const read = <T>(map: Map<string, Entry<T>>, key: string): T | undefined => {
    const entry = map.get(key);

    if (!entry) {
        return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
    }

    return entry.value;
};

const write = <T>(map: Map<string, Entry<T>>, key: string, value: T): void => {
    // Re-inserting moves the key to the end, so insertion order stays age order.
    map.delete(key);
    map.set(key, { value, expiresAt: Date.now() + TTL_MS });

    if (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next().value;

        if (oldest !== undefined) {
            map.delete(oldest);
        }
    }
};

const tokenKey = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The user a refresh cookie belongs to, loading it on a miss. A null answer is not kept. */
export const sessionUser = (token: string, load: () => string | null): string | null => {
    const key = tokenKey(token);
    const cached = read(sessions, key);

    if (cached !== undefined) {
        return cached;
    }

    const userId = load();

    if (userId !== null) {
        write(sessions, key, userId);
    }

    return userId;
};

/** A user's authorization state, building it on a miss. A throw is not kept. */
export const authContext = (userId: string, build: () => AuthContext): AuthContext => {
    const cached = read(contexts, userId);

    if (cached !== undefined) {
        return cached;
    }

    const context = build();
    write(contexts, userId, context);

    return context;
};

/**
 * Forget everything, so the next request reads the database.
 *
 * All of it rather than one user's entries, deliberately: the callers are rare admin and
 * account actions, a refill is one read per active user, and a library change alters every
 * user's accessible roots at once — a narrower invalidation would be a second thing to get
 * right for no measurable gain.
 */
export const forgetAuth = (): void => {
    sessions.clear();
    contexts.clear();
};
