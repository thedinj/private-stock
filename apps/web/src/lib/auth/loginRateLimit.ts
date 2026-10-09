import {
    RateLimitError,
    backoffDelayMs,
    clientIpFrom,
    createRateLimiter,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/**
 * Slowing down password guessing (§12).
 *
 * Two controls, of deliberately different kinds, because the two keys belong to different
 * people:
 *
 *   - **Per account — a delay, never a refusal.** Guessing a password means guessing against
 *     one address over and over, so this is the control that meets the attack. It is a
 *     throttle rather than a gate because the account name is the *victim's*: once this app
 *     is reachable from the internet, a lockout keyed on an address anybody can learn is a
 *     remote off switch for somebody else's library. See `backoffDelayMs`.
 *   - **Per source — a refusal.** Spraying one common password across many accounts never
 *     trips the first control, since no single account sees many attempts. Here refusing is
 *     the right shape: the key is the caller's own address, so the person inconvenienced by
 *     a false positive is the one making the attempts.
 *
 * `login` deliberately runs a password comparison even for an address that does not exist, so
 * that response time reveals nothing — which means every unauthenticated attempt costs a
 * bcrypt hash at cost 12. On a NAS that is the expensive part, and a reason to refuse early.
 *
 * What this cannot do is stop a patient attacker outright. A throttled account still admits a
 * few guesses a minute forever, where a lockout admitted ten a window; that is the price of
 * not handing out a denial of service, and it is paid knowingly. The compensating control is
 * outside the app: `docker/docker-compose.fail2ban.yml` bans a source at the firewall after a
 * run of failures, which is the only layer that can make the attempts stop arriving.
 */

/** Fifteen minutes: long enough to be a real deterrent, short enough to wait out a mistake. */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Three free attempts against an account, then a doubling wait capped at ten seconds.
 *
 * Three covers mistyping a password you know — the fourth attempt waits half a second, which
 * nobody notices. By the ninth the wait is at its ceiling, which leaves an attacker something
 * like six guesses a minute against one account, permanently, with no window to wait out.
 *
 * Ten seconds rather than more because each waiting attempt is a socket held open, and the
 * per-source refusal below is what bounds how many can be held at once.
 */
const ACCOUNT_BACKOFF = { free: 3, stepMs: 500, maxMs: 10_000 };

/**
 * Sixty from one address, covering every account together.
 *
 * Deliberately loose. Several people behind one NAT share an address, and when no proxy is
 * configured this limiter degrades to a single bucket for the whole world (see `sourceKey`)
 * — so it has to be a backstop against spraying, not the primary defence.
 */
const PER_SOURCE_LIMIT = 60;

/**
 * No refusal is ever issued from this one; only `count` is read.
 *
 * The limit is set past anything a window can hold, so that `allowed` cannot quietly become
 * load-bearing if somebody later reads it — there is no number of attempts against an account
 * that this control answers with "no".
 */
const perAccount = createRateLimiter({ limit: Number.MAX_SAFE_INTEGER, windowMs: WINDOW_MS });

const perSource = createRateLimiter({ limit: PER_SOURCE_LIMIT, windowMs: WINDOW_MS });

/**
 * One bucket per address, or one shared bucket when there is no address to be had.
 *
 * Next's standalone server hands a route handler no socket address, so the only source of a
 * client address is a forwarded header — and an untrusted one is worse than none, because a
 * caller who can set it can both evade their own limit and consume someone else's.
 *
 * The shared fallback is honest about what it is: it cannot tell two callers apart, so it
 * only ever catches total volume, and one noisy caller spends the budget for everyone. That
 * is tolerable only because it is what a LAN-direct deployment gets. The Caddy overlay sets
 * `PRIVATE_STOCK_TRUSTED_PROXY_HOPS=1` and overwrites `X-Forwarded-For` with the address it
 * saw, which turns this back into a real per-address limit — and an internet-facing
 * deployment must be behind that overlay for exactly this reason.
 */
const sourceKey = (request: Request, hops: number): string =>
    clientIpFrom(request.headers, hops) ?? "unidentified";

/** Lower-cased, because `findByEmail` matches case-insensitively and the buckets must agree. */
const accountKey = (email: string): string => email.trim().toLowerCase();

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Refuse an attempt that is over the source limit; slow one that is working an account.
 *
 * Awaited before the password is checked, so a refused attempt costs no hash and a throttled
 * one pays its wait before the expensive part rather than after.
 *
 * The refusal message names no account and distinguishes no failure mode, for the same reason
 * `login` returns one message for every way it can fail: saying "too many attempts for this
 * account" would confirm the account exists. The delay is silent for the same reason — a
 * caller cannot tell a throttled real account from a throttled invented one, because both
 * are counted.
 */
export const checkLoginRate = async (request: Request, email: string): Promise<void> => {
    const { trustedProxyHops } = loadConfig();

    // Both are counted before either is acted on. Short-circuiting would let an attacker who
    // has already tripped the source limit keep hammering one account for free, since the
    // per-account counter would stop advancing and its delay would stop growing.
    const source = perSource.check(sourceKey(request, trustedProxyHops));
    const attempts = perAccount.check(accountKey(email));

    if (!source.allowed) {
        throw new RateLimitError(
            "Too many sign-in attempts. Try again shortly.",
            source.retryAfterSeconds
        );
    }

    const delay = backoffDelayMs(attempts.count, ACCOUNT_BACKOFF);

    if (delay > 0) {
        await sleep(delay);
    }
};

/**
 * Clear the account's delay after a successful sign-in.
 *
 * The source count is deliberately left standing: a correct password proves something about
 * the account, not about the address, and an attacker who guesses one account's password
 * should not thereby get a fresh budget to spray the rest.
 */
export const clearLoginRate = (email: string): void => {
    perAccount.reset(accountKey(email));
};
