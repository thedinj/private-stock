import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Login rate limiting (§12).
 *
 * The limiters are module state, so each test re-imports the module to get its own. That is
 * the point of the design rather than an awkwardness to work around: the counts live in the
 * web process and nowhere else, which is what keeps a guessing attempt from costing a write
 * to the database the worker is holding.
 *
 * `RateLimitError` is re-imported alongside it for the same reason: resetting the module
 * registry produces a fresh copy of every module in the graph, so a class captured before the
 * reset is a different class from the one thrown after it, and `toThrow(...)` would fail
 * against an error that is in every other respect correct.
 *
 * The clock is faked throughout, because the per-account control is a delay: a test that let
 * it elapse for real would spend ten seconds proving one assertion.
 */

let hops = 0;

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ trustedProxyHops: hops }),
}));

type Limiter = typeof import("./loginRateLimit");
type Core = typeof import("@private-stock/core");

let checkLoginRate: Limiter["checkLoginRate"];
let clearLoginRate: Limiter["clearLoginRate"];
let RateLimitError: Core["RateLimitError"];

/** The instance type, which the `let` above is the constructor for. */
type RateLimited = InstanceType<Core["RateLimitError"]>;

beforeEach(async () => {
    hops = 0;
    vi.resetModules();
    vi.useFakeTimers();

    ({ checkLoginRate, clearLoginRate } = await import("./loginRateLimit"));
    ({ RateLimitError } = await import("@private-stock/core"));
});

afterEach(() => {
    vi.useRealTimers();
});

const request = (values: Record<string, string> = {}): Request =>
    new Request("http://nas:8842/api/auth/login", { method: "POST", headers: values });

/**
 * One attempt, resolving once its delay (if any) has elapsed on the fake clock.
 *
 * `runAllTimersAsync` is what advances the pending `setTimeout`. It has to be started before
 * the promise is awaited, or the test waits for a timer that nothing will ever fire.
 */
const attempt = async (email: string, headers: Record<string, string> = {}): Promise<void> => {
    const pending = checkLoginRate(request(headers), email);
    const settled = pending.then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const
    );

    await vi.runAllTimersAsync();

    const result = await settled;

    if (!result.ok) {
        throw result.error;
    }
};

/** How long an attempt waited, in milliseconds of fake time. */
const delayOf = async (email: string, headers: Record<string, string> = {}): Promise<number> => {
    const before = Date.now();

    await attempt(email, headers);

    return Date.now() - before;
};

const attemptTimes = async (
    count: number,
    email: string,
    headers: Record<string, string> = {}
): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
        await attempt(email, headers);
    }
};

/**
 * The per-account control is a throttle, never a gate.
 *
 * A lockout keyed on an email address is a remote off switch anybody who knows the address
 * can pull, which is a denial of service the moment the app is reachable from the internet.
 * These tests exist to keep it that way: the one that matters most is the last.
 */
describe("per-account throttling", () => {
    it("lets a person mistype their password without noticing anything", async () => {
        expect(await delayOf("a@b.c")).toBe(0);
        expect(await delayOf("a@b.c")).toBe(0);
        expect(await delayOf("a@b.c")).toBe(0);
    });

    it("starts waiting once the free attempts are spent, and doubles", async () => {
        await attemptTimes(3, "a@b.c");

        expect(await delayOf("a@b.c")).toBe(500);
        expect(await delayOf("a@b.c")).toBe(1_000);
        expect(await delayOf("a@b.c")).toBe(2_000);
    });

    it("stops growing at the cap, so an attempt is never a socket held for ever", async () => {
        await attemptTimes(20, "a@b.c");

        expect(await delayOf("a@b.c")).toBe(10_000);
    });

    /**
     * The point of the whole design, and the reason the lockout it replaced had to go.
     *
     * The attack this models is somebody who wants a *particular* person shut out of their
     * own library: junk attempts against an address they know, from enough places that no
     * single source limit ever trips. Against a per-account lockout that costs nothing and
     * works indefinitely. Here it only ever slows the owner down, so the attempt that finally
     * carries the right password is answered rather than refused.
     */
    it("never refuses the owner, however widely the account is hammered", async () => {
        hops = 1;

        for (let index = 0; index < 200; index += 1) {
            await attempt("victim@b.c", { "x-forwarded-for": `203.0.113.${index % 256}` });
        }

        await expect(
            attempt("victim@b.c", { "x-forwarded-for": "198.51.100.9" })
        ).resolves.toBeUndefined();
    });

    it("does not spend one account's patience on another", async () => {
        await attemptTimes(20, "a@b.c");

        expect(await delayOf("d@e.f")).toBe(0);
    });

    /** `findByEmail` matches case-insensitively, so the buckets have to agree with it. */
    it("treats an address as the same account whatever its capitalisation", async () => {
        await attemptTimes(3, "a@b.c");

        expect(await delayOf("A@B.C")).toBe(500);
        expect(await delayOf("  a@b.c  ")).toBe(1_000);
    });

    it("clears the delay when the password was right after all", async () => {
        await attemptTimes(9, "a@b.c");
        clearLoginRate("a@b.c");

        expect(await delayOf("a@b.c")).toBe(0);
    });
});

describe("per-source limiting", () => {
    beforeEach(() => {
        hops = 1;
    });

    const from = (ip: string) => ({ "x-forwarded-for": ip });

    const spray = async (ip: string, count = 60): Promise<void> => {
        for (let account = 0; account < count; account += 1) {
            await attempt(`user${account}@b.c`, from(ip));
        }
    };

    /**
     * Spraying one password across many accounts never trips the per-account throttle,
     * because no account sees more than a couple of attempts. This is the control that sees
     * it — and here refusal is right, because the key is the caller's own address.
     */
    it("catches one address working through many accounts", async () => {
        await spray("203.0.113.5");

        await expect(attempt("someone-else@b.c", from("203.0.113.5"))).rejects.toThrow(
            RateLimitError
        );
    });

    it("leaves another address alone", async () => {
        await spray("203.0.113.5");

        await expect(attempt("fresh@b.c", from("198.51.100.9"))).resolves.toBeUndefined();
    });

    it("says how long to wait", async () => {
        await spray("203.0.113.5");

        try {
            await attempt("one-more@b.c", from("203.0.113.5"));
            expect.unreachable("should have been refused");
        } catch (error) {
            expect((error as RateLimited).retryAfterSeconds).toBeGreaterThan(0);
        }
    });

    /**
     * The message must not distinguish a real account from an invented one. `login` returns
     * one message for every failure so that response content is not an enumeration oracle; a
     * limiter that said "too many attempts for this account" would hand back exactly what
     * that is protecting.
     */
    it("names no account and admits no failure mode", async () => {
        await spray("203.0.113.5");

        try {
            await attempt("a@b.c", from("203.0.113.5"));
            expect.unreachable("should have been refused");
        } catch (error) {
            expect((error as Error).message).not.toContain("a@b.c");
            expect((error as Error).message).toMatch(/too many sign-in attempts/i);
        }
    });

    /**
     * Without a trusted proxy the header is the caller's own, so honouring it would let an
     * attacker rotate it and never accumulate a count at all.
     */
    it("ignores a forwarded address when no proxy is configured", async () => {
        hops = 0;

        for (let account = 0; account < 60; account += 1) {
            await attempt(`user${account}@b.c`, from(`10.0.0.${account}`));
        }

        await expect(attempt("one-more@b.c", from("10.0.0.200"))).rejects.toThrow(RateLimitError);
    });

    /**
     * A correct password proves something about the account, not about the address. Clearing
     * the source count here would hand an attacker who guessed one password a fresh budget
     * with which to spray the rest.
     */
    it("survives a successful sign-in from the same address", async () => {
        await spray("203.0.113.5");

        clearLoginRate("user0@b.c");

        await expect(attempt("user0@b.c", from("203.0.113.5"))).rejects.toThrow(RateLimitError);
    });

    /**
     * Both controls advance on every attempt, whatever either of them says.
     *
     * If the source check short-circuited the account count, an attacker who had already
     * tripped the source limit could keep hammering one account for free — its delay would
     * simply stop growing, and would be back to nothing when they moved to a fresh address.
     */
    it("keeps counting an account even once the source is already refused", async () => {
        await spray("203.0.113.5");

        // Over the source limit, so these all throw — but they must still be counted.
        for (let index = 0; index < 10; index += 1) {
            await expect(attempt("target@b.c", from("203.0.113.5"))).rejects.toThrow(
                RateLimitError
            );
        }

        // From an address with budget to spare, the account has been throttled all along.
        expect(await delayOf("target@b.c", from("198.51.100.9"))).toBe(10_000);
    });
});
