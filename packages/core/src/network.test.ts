import { describe, expect, it } from "vitest";

import { clientIpFrom, isHttpsRequest } from "./network.js";

/**
 * Identifying a caller behind a proxy (§12).
 *
 * The whole value of this file is in what it *refuses* to believe. A forwarded header is a
 * claim, and the rate limiter keys on the answer — so getting it wrong either lets an
 * attacker evade a limit by rotating a header they control, or lets them push somebody else
 * over it and lock them out of their own account.
 */

const headers = (values: Record<string, string>): Headers => new Headers(values);

describe("clientIpFrom", () => {
    it("believes nothing when no proxy is trusted", () => {
        expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.5" }), 0)).toBeNull();
    });

    it("takes the address our own proxy saw", () => {
        expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.5" }), 1)).toBe("203.0.113.5");
    });

    /**
     * Everything left of our proxy's entry was written by the caller.
     *
     * A client that sends `X-Forwarded-For: 10.0.0.1` has its own address appended by Caddy,
     * so the forged value moves left and the real one is the entry we read.
     */
    it("ignores entries the caller supplied themselves", () => {
        const forged = headers({ "x-forwarded-for": "10.0.0.1, 198.51.100.9" });

        expect(clientIpFrom(forged, 1)).toBe("198.51.100.9");
    });

    it("counts back one entry per proxy", () => {
        const chain = headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.5, 192.0.2.7" });

        expect(clientIpFrom(chain, 2)).toBe("203.0.113.5");
    });

    /**
     * A chain shorter than the deployment claims means the request did not come through the
     * proxies it was supposed to. The leftmost entry is not a substitute for the client.
     */
    it("claims nothing when the chain is shorter than the hop count", () => {
        expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.5" }), 2)).toBeNull();
    });

    it("claims nothing when the header is absent", () => {
        expect(clientIpFrom(headers({}), 1)).toBeNull();
    });

    /** One host is one bucket, however the address is decorated. */
    it("normalises ports, brackets and v4-mapped addresses", () => {
        expect(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.5:41234" }), 1)).toBe(
            "203.0.113.5"
        );
        expect(clientIpFrom(headers({ "x-forwarded-for": "[2001:db8::1]:443" }), 1)).toBe(
            "2001:db8::1"
        );
        expect(clientIpFrom(headers({ "x-forwarded-for": "::ffff:203.0.113.5" }), 1)).toBe(
            "203.0.113.5"
        );
        expect(clientIpFrom(headers({ "x-forwarded-for": "2001:DB8::1" }), 1)).toBe("2001:db8::1");
    });

    it("survives a header that is empty or all separators", () => {
        expect(clientIpFrom(headers({ "x-forwarded-for": "" }), 1)).toBeNull();
        expect(clientIpFrom(headers({ "x-forwarded-for": " , , " }), 1)).toBeNull();
    });
});

describe("isHttpsRequest", () => {
    const request = (url: string, values: Record<string, string> = {}): Request =>
        new Request(url, { headers: values });

    it("reads the proxy's word when there is a proxy", () => {
        const proxied = request("http://nas:8842/", { "x-forwarded-proto": "https" });

        expect(isHttpsRequest(proxied, 1)).toBe(true);
    });

    /**
     * Without a proxy the header is the caller's to set, and believing it marks the refresh
     * cookie `Secure` on a plain-HTTP LAN deployment — where the browser then silently
     * declines to send it back, and login appears to do nothing.
     */
    it("ignores the header when nothing is trusted", () => {
        const spoofed = request("http://nas:8842/", { "x-forwarded-proto": "https" });

        expect(isHttpsRequest(spoofed, 0)).toBe(false);
    });

    it("falls back to the scheme the request actually arrived on", () => {
        expect(isHttpsRequest(request("https://nas:8842/"), 0)).toBe(true);
        expect(isHttpsRequest(request("http://nas:8842/"), 1)).toBe(false);
    });

    it("reads the first entry when several proxies appended one", () => {
        const chained = request("http://nas:8842/", { "x-forwarded-proto": "https, http" });

        expect(isHttpsRequest(chained, 2)).toBe(true);
    });
});
