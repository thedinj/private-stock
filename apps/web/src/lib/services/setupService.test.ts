import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who is allowed to claim the library (§12, §12c).
 *
 * Setup is the one request that hands out `admin` and `delete` to whoever asks, guarded only
 * by "there are no users yet" and "you are on the LAN". So the question worth testing is
 * whether the second guard can be talked out of, and it could: the address came from the
 * leftmost `X-Forwarded-For` entry, which is the one the *client* appends. A remote caller
 * who sent `X-Forwarded-For: 10.0.0.1` was judged private and never asked for the token.
 *
 * The address now comes from `clientIpFrom` under `trustedProxyHops`, the same arithmetic
 * that identifies a caller for rate limiting.
 */

let trustedProxyHops = 0;

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ trustedProxyHops }),
}));

vi.mock("@private-stock/db", () => ({
    userRepo: { countUsers: () => 0 },
}));

const createUser = vi.fn();

vi.mock("./authService", () => ({
    createUser: (...args: unknown[]) => createUser(...args),
}));

const { completeSetup, isPrivateRequest } = await import("./setupService");

/** A request from outside, reaching a public hostname, carrying whatever headers it likes. */
const remoteRequest = (headers: Record<string, string> = {}): Request =>
    new Request("https://library.example.com/api/setup", { headers });

beforeEach(() => {
    trustedProxyHops = 0;
    createUser.mockReset();
});

describe("isPrivateRequest", () => {
    it("ignores a forged X-Forwarded-For when no proxy is trusted", () => {
        expect(isPrivateRequest(remoteRequest({ "x-forwarded-for": "10.0.0.1" }))).toBe(false);
        expect(isPrivateRequest(remoteRequest({ "x-forwarded-for": "127.0.0.1" }))).toBe(false);
        expect(isPrivateRequest(remoteRequest({ "x-forwarded-for": "192.168.1.5" }))).toBe(false);
    });

    it("ignores entries the caller prepended to a real proxy's chain", () => {
        trustedProxyHops = 1;

        // The proxy appended 203.0.113.9; everything left of it is the caller's claim.
        expect(
            isPrivateRequest(remoteRequest({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" }))
        ).toBe(false);
    });

    it("believes the entry our own proxy appended", () => {
        trustedProxyHops = 1;

        expect(
            isPrivateRequest(remoteRequest({ "x-forwarded-for": "203.0.113.9, 192.168.1.5" }))
        ).toBe(true);
    });

    /**
     * The regression this file exists for now.
     *
     * There used to be a fallback here: with nothing vouching for an address, the hostname in
     * `request.url` was read instead. The test for it constructed `new Request("http://nas:...")`
     * by hand and passed -- but Next's standalone server builds that URL from HOSTNAME, which
     * entrypoint.sh sets to 0.0.0.0 so the server binds every interface. So in production the
     * fallback read 0.0.0.0, judged every caller remote, and demanded a token that nothing
     * printed. The test asserted the shape its author expected Next to produce.
     *
     * Hence 0.0.0.0 below, spelled out: it is the value that actually arrives.
     */
    it("says no when nothing can vouch for the caller", () => {
        expect(isPrivateRequest(new Request("http://0.0.0.0:8842/api/setup"))).toBe(false);
        expect(isPrivateRequest(new Request("http://nas:8842/api/setup"))).toBe(false);
        expect(isPrivateRequest(new Request("http://127.0.0.1:8842/api/setup"))).toBe(false);
        expect(isPrivateRequest(remoteRequest())).toBe(false);
    });

    /**
     * A Host header is written by the caller, so it cannot stand in for one.
     *
     * Reading it would have fixed the 0.0.0.0 fault while leaving the real one: `Host: nas` is
     * one line of curl, and this is the request that hands out `admin` and `delete`.
     */
    it("does not accept a Host header as evidence of being on the LAN", () => {
        const forged = new Request("https://library.example.com/api/setup", {
            headers: { host: "nas" },
        });

        expect(isPrivateRequest(forged)).toBe(false);
    });

    /**
     * A name in `X-Forwarded-For` is not an address. Some proxies write `unknown` there, and
     * "no dots, so probably the LAN" once waved exactly that through.
     */
    it("does not take a name in the forwarded chain for a LAN address", () => {
        trustedProxyHops = 1;

        expect(isPrivateRequest(remoteRequest({ "x-forwarded-for": "unknown" }))).toBe(false);
        expect(isPrivateRequest(remoteRequest({ "x-forwarded-for": "nas" }))).toBe(false);
    });
});

describe("getSetupToken", () => {
    /**
     * The token is delivered by being printed. It was previously generated inside the
     * comparison that rejects a wrong one and printed nowhere, so the only way to learn it was
     * to already know it.
     */
    it("prints the token when it generates one", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const { getSetupToken } = await import("./setupService");

        const token = getSetupToken();

        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(log.mock.calls.flat().join(" ")).toContain(token);

        log.mockRestore();
    });

    it("keeps the same token for the life of the process", async () => {
        const { getSetupToken } = await import("./setupService");

        expect(getSetupToken()).toBe(getSetupToken());
    });
});

/** Last, because the first call anywhere in the file generates the process's token. */
describe("completeSetup", () => {
    const input = { email: "a@b.c", displayName: "A", password: "secret-enough" };

    it("refuses a remote caller with the wrong token, or none", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});

        await expect(
            completeSetup({ ...input, setupToken: "0".repeat(32) }, remoteRequest())
        ).rejects.toThrow(/token/);
        await expect(completeSetup(input, remoteRequest())).rejects.toThrow(/token/);
        expect(createUser).not.toHaveBeenCalled();
    });

    it("accepts a remote caller holding the printed token", async () => {
        const { getSetupToken } = await import("./setupService");

        await completeSetup({ ...input, setupToken: getSetupToken() }, remoteRequest());

        expect(createUser).toHaveBeenCalledOnce();
    });
});
