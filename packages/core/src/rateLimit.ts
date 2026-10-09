/**
 * Rate limiting (§12).
 *
 * A fixed-window counter per key, in memory. Pure enough to test with a clock, and
 * deliberately not in the database: a login attempt that costs a write is a login attempt an
 * attacker can use to make the disk work, and the `Job` table already shares that file with
 * a worker holding it for minutes at a time.
 *
 * The cost of memory is that the count resets when the container restarts, which is a real
 * limitation and an acceptable one — an attacker who can restart the container has already
 * won something bigger than a password.
 */

export interface RateLimitResult {
    allowed: boolean;
    /** How long until the window rolls over. Becomes `Retry-After`. */
    retryAfterSeconds: number;
    /** Attempts left in this window, for a caller that wants to warn before blocking. */
    remaining: number;
    /**
     * Attempts made in this window, including the one just counted.
     *
     * For a caller whose response to volume is something other than refusal — the login
     * throttle grows a delay from it (§12) — and which therefore has no meaningful `limit`
     * for `remaining` to be measured against.
     */
    count: number;
}

export interface RateLimiterOptions {
    /** Attempts permitted per window. */
    limit: number;
    windowMs: number;
    /** Injected so the tests do not sleep. */
    now?: () => number;
}

export interface RateLimiter {
    /** Count one attempt against `key` and say whether it may proceed. */
    check: (key: string) => RateLimitResult;
    /** Forget a key — called on success, so a correct password clears the count. */
    reset: (key: string) => void;
    /** Number of keys currently held, for the sweep's own test. */
    size: () => number;
}

/**
 * Windows are swept lazily, on use.
 *
 * A timer would keep a handle alive for the life of the process to tidy a map that is empty
 * most of the time; sweeping when a new key arrives costs nothing and bounds the map by the
 * number of distinct callers in one window rather than by uptime.
 */
const SWEEP_EVERY = 256;

export const createRateLimiter = ({
    limit,
    windowMs,
    now = Date.now,
}: RateLimiterOptions): RateLimiter => {
    const windows = new Map<string, { count: number; expiresAt: number }>();
    let sinceSweep = 0;

    const sweep = (at: number): void => {
        for (const [key, window] of windows) {
            if (window.expiresAt <= at) {
                windows.delete(key);
            }
        }
    };

    return {
        check: (key) => {
            const at = now();

            if ((sinceSweep += 1) >= SWEEP_EVERY) {
                sinceSweep = 0;
                sweep(at);
            }

            const existing = windows.get(key);
            const window =
                existing && existing.expiresAt > at
                    ? existing
                    : { count: 0, expiresAt: at + windowMs };

            window.count += 1;
            windows.set(key, window);

            const retryAfterSeconds = Math.max(1, Math.ceil((window.expiresAt - at) / 1000));

            return {
                // The attempt that reaches the limit is refused, not the one after it.
                allowed: window.count <= limit,
                retryAfterSeconds,
                remaining: Math.max(0, limit - window.count),
                count: window.count,
            };
        },

        reset: (key) => {
            windows.delete(key);
        },

        size: () => windows.size,
    };
};
