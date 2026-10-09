import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentUser, refreshSession, setSession } from "./client";

/**
 * Restoring a session on load (§12).
 *
 * Only a 401 means signed out. Every other failure — a dev server recompiling, the worker
 * holding the database's write lock, the network blinking — used to send people to the login
 * page with a perfectly good cookie.
 */

const SIGNED_IN = {
    accessToken: "token",
    expiresInSeconds: 900,
    user: { id: "u-1", email: "me@example.test", displayName: "Me", scopes: [] as never[] },
};

const reply = (status: number, body: unknown = {}) =>
    Promise.resolve(
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );

/** Runs the refresh to completion, stepping over its waits between attempts. */
const settle = async () => {
    const result = refreshSession();

    await vi.runAllTimersAsync();

    return result;
};

beforeEach(() => {
    vi.useFakeTimers();
    setSession(null);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setSession(null);
});

describe("refreshSession", () => {
    it("restores the session on success", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => reply(200, SIGNED_IN))
        );

        expect(await settle()).toBe(true);
        expect(getCurrentUser()?.id).toBe("u-1");
    });

    it("gives up at once on a 401, which is the only answer that means signed out", async () => {
        const fetchMock = vi.fn(() => reply(401));
        vi.stubGlobal("fetch", fetchMock);

        expect(await settle()).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["a server error", () => reply(503)],
        ["rate limiting", () => reply(429)],
        ["the network", () => Promise.reject(new TypeError("Failed to fetch"))],
    ])("retries through %s and keeps the session", async (_label, failure) => {
        const fetchMock = vi
            .fn<() => Promise<Response>>()
            .mockImplementationOnce(failure)
            .mockImplementationOnce(failure)
            .mockImplementation(() => reply(200, SIGNED_IN));
        vi.stubGlobal("fetch", fetchMock);

        expect(await settle()).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("gives up once every attempt has failed", async () => {
        const fetchMock = vi.fn(() => reply(503));
        vi.stubGlobal("fetch", fetchMock);

        expect(await settle()).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(getCurrentUser()).toBeNull();
    });

    it("shares one refresh between callers who ask at once", async () => {
        const fetchMock = vi.fn(() => reply(200, SIGNED_IN));
        vi.stubGlobal("fetch", fetchMock);

        const both = Promise.all([refreshSession(), refreshSession()]);
        await vi.runAllTimersAsync();

        expect(await both).toEqual([true, true]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
