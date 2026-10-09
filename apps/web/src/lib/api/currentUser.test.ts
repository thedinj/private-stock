import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchCurrentUser, getCurrentUser, setSession } from "./client";

/**
 * Re-reading who we are (§12c).
 *
 * The session user was read once, at sign-in, and then never again — so anything that changed
 * the account afterwards left the shell showing what was true when the person signed in. The
 * foot of the navbar is where it showed: renaming your own account from Admin › People updated
 * the row, the database and the admin table, and went on calling you the old name.
 *
 * `/api/auth/me` is the right source because it reads the `User` row; the access token still
 * carries the name and scopes it was minted with.
 */

const SIGNED_IN = {
    accessToken: "token",
    expiresInSeconds: 900,
    user: { id: "u-1", email: "boss@example.test", displayName: "Boss", scopes: [] as never[] },
};

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

beforeEach(() => {
    setSession(SIGNED_IN);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
});

describe("fetchCurrentUser", () => {
    it("adopts the name the server now reports", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() =>
                Promise.resolve(jsonResponse({ ...SIGNED_IN.user, displayName: "The Boss" }))
            )
        );

        const user = await fetchCurrentUser();

        expect(user?.displayName).toBe("The Boss");
        expect(getCurrentUser()?.displayName).toBe("The Boss");
    });

    /** Scopes go stale the same way, and worse: the server reads them from the row per request. */
    it("adopts scopes granted since sign-in", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve(jsonResponse({ ...SIGNED_IN.user, scopes: ["delete"] })))
        );

        expect((await fetchCurrentUser())?.scopes).toEqual(["delete"]);
    });

    it("reads the account rather than the session", async () => {
        // Typed, so the recorded call can be read back — an untyped `vi.fn(() => …)` records
        // its arguments as an empty tuple and indexing one is a compile error.
        const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
            Promise.resolve(jsonResponse(SIGNED_IN.user))
        );
        vi.stubGlobal("fetch", fetchMock);

        await fetchCurrentUser();

        expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/me");
    });

    /**
     * A failed read is not evidence of a changed identity. Blanking the name would put
     * "Account" at the foot of the rail because the network blinked.
     */
    it("keeps the name it had when the server cannot answer", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.resolve(jsonResponse({ message: "nope" }, 500)))
        );

        expect((await fetchCurrentUser())?.displayName).toBe("Boss");
        expect(getCurrentUser()?.displayName).toBe("Boss");
    });

    it("keeps it when the request never reaches the server at all", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject(new TypeError("Failed to fetch")))
        );

        expect((await fetchCurrentUser())?.displayName).toBe("Boss");
    });
});
