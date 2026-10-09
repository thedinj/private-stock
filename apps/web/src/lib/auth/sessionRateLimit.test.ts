import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Limiting the authenticated credential endpoints (§12).
 *
 * Module state again, so each test re-imports for its own counters — and re-imports
 * `RateLimitError` alongside, because resetting the module registry produces a fresh copy of
 * every class in the graph and a constructor captured before the reset is not the one thrown
 * after it. See `loginRateLimit.test.ts` for the same reasoning at length.
 */

let hops = 0;

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ trustedProxyHops: hops }),
}));

type Limiter = typeof import("./sessionRateLimit");
type Core = typeof import("@private-stock/core");

let checkPasswordChangeRate: Limiter["checkPasswordChangeRate"];
let checkRefreshRate: Limiter["checkRefreshRate"];
let RateLimitError: Core["RateLimitError"];

type RateLimited = InstanceType<Core["RateLimitError"]>;

beforeEach(async () => {
    hops = 0;
    vi.resetModules();

    ({ checkPasswordChangeRate, checkRefreshRate } = await import("./sessionRateLimit"));
    ({ RateLimitError } = await import("@private-stock/core"));
});

const request = (values: Record<string, string> = {}): Request =>
    new Request("http://nas:8842/api/auth/refresh", { method: "POST", headers: values });

describe("password change limiting", () => {
    it("allows an honest run of changes", () => {
        for (let index = 0; index < 10; index += 1) {
            expect(() => checkPasswordChangeRate("user-1")).not.toThrow();
        }
    });

    /**
     * The endpoint verifies the current password with bcrypt at cost 12 before it rejects
     * anything, so unmetered it is an unbounded CPU oracle on the box that is also
     * transcoding (§17).
     */
    it("refuses once the account has been at it too long", () => {
        for (let index = 0; index < 10; index += 1) {
            checkPasswordChangeRate("user-1");
        }

        expect(() => checkPasswordChangeRate("user-1")).toThrow(RateLimitError);
    });

    it("says how long to wait", () => {
        for (let index = 0; index < 11; index += 1) {
            try {
                checkPasswordChangeRate("user-1");
            } catch (error) {
                expect((error as RateLimited).retryAfterSeconds).toBeGreaterThan(0);
            }
        }
    });

    /**
     * Keyed by user id, not by address: the caller is already authenticated, so a better key
     * than a header is available, and it holds when they move between networks.
     */
    it("does not spend one account's budget on another", () => {
        for (let index = 0; index < 10; index += 1) {
            checkPasswordChangeRate("user-1");
        }

        expect(() => checkPasswordChangeRate("user-2")).not.toThrow();
    });
});

describe("refresh limiting", () => {
    beforeEach(() => {
        hops = 1;
    });

    const from = (ip: string) => request({ "x-forwarded-for": ip });

    /**
     * Sized for real use: an access token lives fifteen minutes, so an open session refreshes
     * about once per window. Several people with several devices must not come near this.
     */
    it("allows far more than any household will ever need", () => {
        for (let index = 0; index < 240; index += 1) {
            expect(() => checkRefreshRate(from("203.0.113.5"))).not.toThrow();
        }
    });

    it("refuses a flood from one address", () => {
        for (let index = 0; index < 240; index += 1) {
            checkRefreshRate(from("203.0.113.5"));
        }

        expect(() => checkRefreshRate(from("203.0.113.5"))).toThrow(RateLimitError);
    });

    it("leaves another address alone", () => {
        for (let index = 0; index < 240; index += 1) {
            checkRefreshRate(from("203.0.113.5"));
        }

        expect(() => checkRefreshRate(from("198.51.100.9"))).not.toThrow();
    });

    /**
     * Without a trusted proxy the header is the caller's own, so honouring it would let a
     * caller rotate it and never accumulate a count at all.
     */
    it("ignores a forwarded address when no proxy is configured", () => {
        hops = 0;

        for (let index = 0; index < 240; index += 1) {
            checkRefreshRate(from(`10.0.0.${index % 256}`));
        }

        expect(() => checkRefreshRate(from("10.0.0.200"))).toThrow(RateLimitError);
    });
});
