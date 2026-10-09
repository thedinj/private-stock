import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rateLimit.js";

/**
 * The login limiter's arithmetic (§12).
 *
 * Tested with an injected clock rather than by waiting: the behaviour that matters is what
 * happens at the boundaries of a window, and a test that sleeps for one is a test nobody runs.
 */

const limiterAt = (time: { value: number }, limit = 3, windowMs = 1000) =>
    createRateLimiter({ limit, windowMs, now: () => time.value });

describe("createRateLimiter", () => {
    it("allows attempts up to the limit and refuses the one that passes it", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        expect(limiter.check("a").allowed).toBe(true);
        expect(limiter.check("a").allowed).toBe(true);
        expect(limiter.check("a").allowed).toBe(true);
        expect(limiter.check("a").allowed).toBe(false);
    });

    it("counts each key separately, so one caller cannot exhaust another's budget", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            limiter.check("a");
        }

        expect(limiter.check("b").allowed).toBe(true);
    });

    it("starts a fresh window once the old one has passed", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            limiter.check("a");
        }

        time.value = 1001;

        expect(limiter.check("a").allowed).toBe(true);
    });

    /** A correct password ends the penalty; otherwise a typo earlier still counts against you. */
    it("forgets a key on reset", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            limiter.check("a");
        }

        limiter.reset("a");

        expect(limiter.check("a").allowed).toBe(true);
    });

    it("never reports a wait of zero, which a client would simply retry through", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        expect(limiter.check("a").retryAfterSeconds).toBe(1);

        time.value = 999;

        expect(limiter.check("a").retryAfterSeconds).toBe(1);
    });

    it("counts down what is left", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        expect(limiter.check("a").remaining).toBe(2);
        expect(limiter.check("a").remaining).toBe(1);
        expect(limiter.check("a").remaining).toBe(0);
        expect(limiter.check("a").remaining).toBe(0);
    });

    /**
     * The map must be bounded by callers-per-window, not by uptime.
     *
     * A limiter keyed by address on an internet-facing login is a map an attacker can grow
     * for free, one entry per request, unless expired windows are actually dropped.
     */
    it("drops expired windows rather than growing forever", () => {
        const time = { value: 0 };
        const limiter = limiterAt(time);

        for (let key = 0; key < 300; key += 1) {
            limiter.check(`key-${key}`);
        }

        expect(limiter.size()).toBeGreaterThan(1);

        time.value = 10_000;

        for (let key = 0; key < 300; key += 1) {
            limiter.check(`later-${key}`);
        }

        // Everything from the first burst has expired; only the second burst should remain.
        expect(limiter.size()).toBeLessThanOrEqual(300);
    });
});
