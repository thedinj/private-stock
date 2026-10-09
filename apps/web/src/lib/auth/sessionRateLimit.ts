import { RateLimitError, clientIpFrom, createRateLimiter } from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/**
 * Limiting the credential endpoints that are not the sign-in form (§12).
 *
 * Three endpoints, and not one of them is held shut by the number in its limiter. What
 * actually guards each is a secret too large to guess: a bearer token on
 * `/api/auth/password`, a 128-bit refresh token, a generated invitation code on
 * `/api/auth/register`. These limits bound what an internet-facing deployment *pays* to
 * answer somebody who has noticed the endpoints exist:
 *
 *   - **Password change** verifies the current password with bcrypt at cost 12 before it
 *     rejects anything. Unmetered, that is an unbounded CPU oracle on the box whose CPU is
 *     the binding constraint (§17) — the same machine that is transcoding.
 *   - **Refresh** is only a database read, so it is cheap per call; the limit is a ceiling on
 *     volume against the file the worker is also holding, not a guard on the token.
 *   - **Register** costs a lookup, and past the invitation check a hash. It is also the one
 *     endpoint here a stranger is *supposed* to be able to reach, which is why the reasoning
 *     for its number is written out at length beside it.
 *
 * Each refuses rather than delays, unlike the login throttle. The reasoning that makes a
 * lockout wrong there does not apply: the password-change key is the caller's own account,
 * which they are already signed in to, and the other two are their own address. Nobody can
 * spend somebody else's budget, so nobody can shut anyone out with one.
 */

/** The same window as the login limiters, so a person sees one consistent cool-off. */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Ten password changes per account per window.
 *
 * Far above any honest use — changing a password is a thing done once and then not again for
 * months — and low enough that the hash cost cannot be turned into a load generator.
 */
const PASSWORD_LIMIT = 10;

/**
 * Two hundred and forty refreshes from one address per window.
 *
 * Sized for real use rather than for the attack: an access token lives fifteen minutes, so an
 * open session refreshes about once per window, and several people with several devices each
 * behind one NAT address still come nowhere near. When no proxy is configured this collapses
 * to one bucket for everybody (see `sourceKey` in `loginRateLimit.ts`), which is the other
 * reason it is set this high.
 */
const REFRESH_LIMIT = 240;

/**
 * Twenty registration attempts from one address per window.
 *
 * `/api/auth/register` is unauthenticated and internet-facing, and the invitation code is the
 * only thing guarding it -- so this is the endpoint that most looks like it needs a limiter
 * to hold the line. It does not, and it matters that the reason is written down: **the code
 * is generated, never chosen** (`generateInvitationCode`), so it carries about fifty bits and
 * is not found by guessing at any request rate a network can deliver. This limiter bounds
 * volume, nothing more. If somebody ever adds a way for an admin to pick their own code, that
 * stops being true and this number becomes load-bearing overnight.
 *
 * Twenty rather than the handful an honest person needs, because several people behind one
 * NAT address may be invited on the same evening, and because with no proxy configured this
 * collapses to a single bucket for everybody.
 *
 * Refusal rather than delay: the key is the caller's own address, so nobody else can spend
 * it. The same reasoning as refresh, and the opposite of the login throttle, where the key is
 * somebody's email address.
 */
const REGISTER_LIMIT = 20;

const perAccountPassword = createRateLimiter({ limit: PASSWORD_LIMIT, windowMs: WINDOW_MS });
const perSourceRefresh = createRateLimiter({ limit: REFRESH_LIMIT, windowMs: WINDOW_MS });
const perSourceRegister = createRateLimiter({ limit: REGISTER_LIMIT, windowMs: WINDOW_MS });

const sourceKey = (request: Request): string =>
    clientIpFrom(request.headers, loadConfig().trustedProxyHops) ?? "unidentified";

const refuse = (retryAfterSeconds: number): never => {
    throw new RateLimitError("Too many attempts. Try again shortly.", retryAfterSeconds);
};

/**
 * Count a password change against the account making it.
 *
 * Keyed by user id rather than by address: the caller is authenticated, so there is a better
 * key available than a header, and it holds whether they move between networks.
 */
export const checkPasswordChangeRate = (userId: string): void => {
    const result = perAccountPassword.check(userId);

    if (!result.allowed) {
        refuse(result.retryAfterSeconds);
    }
};

/** Count a refresh against the address making it. There is no better key before the token is
 * looked up, and looking it up first is the cost this exists to bound. */
export const checkRefreshRate = (request: Request): void => {
    const result = perSourceRefresh.check(sourceKey(request));

    if (!result.allowed) {
        refuse(result.retryAfterSeconds);
    }
};

/**
 * Count a registration attempt against the address making it.
 *
 * Checked before the invitation is looked up and long before the password is hashed, so a
 * refused attempt costs neither a query nor a bcrypt hash at cost 12.
 *
 * Deliberately **not** keyed on the submitted code. Keying on it would do nothing against the
 * attack it looks like it addresses -- somebody guessing works through different codes, so
 * every attempt lands in a fresh bucket -- while giving anybody who learns a real code a way
 * to burn its budget and keep the person it was meant for from using it.
 */
export const checkRegisterRate = (request: Request): void => {
    const result = perSourceRegister.check(sourceKey(request));

    if (!result.allowed) {
        refuse(result.retryAfterSeconds);
    }
};
