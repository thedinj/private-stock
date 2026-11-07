import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A request is in one domain, and sees only that domain's libraries (§21).
 *
 * This is the seam the separation rests on: every service filters by `accessibleRootIds`, so if
 * the context a request is handed is narrowed correctly, nothing further down can reach another
 * room. What is proved here is the narrowing, and that a request that does not say which room
 * it is for is refused rather than guessed at.
 */

const SECRET = "test-secret-value-that-is-long-enough";

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ secret: SECRET }),
    resolveSecret: (config: { secret: string }) => config.secret,
}));

const USER = "user-1";

vi.mock("@private-stock/db", () => ({
    userRepo: {
        findById: (id: string) =>
            id === USER
                ? {
                      id: USER,
                      email: "a@b.c",
                      displayName: "Viewer",
                      scopes: "admin",
                      disabled: null,
                      tokenEpoch: 1,
                  }
                : undefined,
    },
    mediaRootRepo: {
        accessibleRoots: () => [
            { id: "home-videos", domain: "family" },
            { id: "cellar-a", domain: "cellar" },
            { id: "cellar-b", domain: "cellar" },
            { id: "clips", domain: "games" },
        ],
    },
    refreshTokenRepo: { findLive: () => undefined },
}));

vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => undefined }),
}));

const { signAccessToken } = await import("./tokens");
const { requireAuth, contextFor } = await import("./withAuth");
const { forgetAuth } = await import("./authCache");

const request = (headers: Record<string, string>, url = "http://host/api/media"): Request =>
    new Request(url, {
        headers: { authorization: `Bearer ${signAccessToken(USER, ["admin"])}`, ...headers },
    });

beforeEach(() => {
    forgetAuth();
});

describe("a request in a domain", () => {
    it("sees that domain's libraries and no others", async () => {
        const family = await requireAuth(request({ "x-ps-domain": "family" }));
        const cellar = await requireAuth(request({ "x-ps-domain": "cellar" }));
        const games = await requireAuth(request({ "x-ps-domain": "games" }));

        expect(family.domain).toBe("family");
        expect(family.accessibleRootIds).toEqual(["home-videos"]);
        expect(cellar.accessibleRootIds).toEqual(["cellar-a", "cellar-b"]);
        expect(games.accessibleRootIds).toEqual(["clips"]);
    });

    it("takes the domain from the query string where a header cannot be sent", async () => {
        const auth = await requireAuth(request({}, "http://host/api/events?domain=games"));

        expect(auth.accessibleRootIds).toEqual(["clips"]);
    });

    it("refuses a request that does not say which room it is for", async () => {
        await expect(requireAuth(request({}))).rejects.toThrow(/which room/);
    });

    it("refuses a room that does not exist rather than falling back to one", async () => {
        await expect(requireAuth(request({ "x-ps-domain": "attic" }))).rejects.toThrow(
            /which room/
        );
    });

    it("leaves the cached context whole, so the next room is narrowed from all of it", async () => {
        await requireAuth(request({ "x-ps-domain": "family" }));

        expect(contextFor(USER).accessibleRootIds).toHaveLength(4);
        expect(contextFor(USER).domain).toBeNull();
    });

    it("lets a per-item route opt out and see every library", async () => {
        const auth = await requireAuth(request({}), { anyDomain: true });

        expect(auth.domain).toBeNull();
        expect(auth.accessibleRootIds).toHaveLength(4);
    });
});
