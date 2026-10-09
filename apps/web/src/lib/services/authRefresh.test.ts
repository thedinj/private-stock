import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "@private-stock/core";

/**
 * Refreshing a session, and the grace after rotation (§12).
 *
 * Every refresh rotates the token, and two requests carrying one cookie — two tabs reloading
 * together, or a reload that cut off a refresh the server had already finished — used to sign
 * the loser out. The repo decides what counts as recently rotated; these tests prove the service
 * uses that answer, and only that answer, to let the loser through.
 */

vi.mock("@private-stock/core/server", async (importActual) => ({
    ...(await importActual<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ secret: "test-secret-value-that-is-long-enough" }),
    resolveSecret: (config: { secret: string }) => config.secret,
}));

interface Row {
    userId: string;
}

let live: Record<string, Row> = {};
let recentlyRotated: Record<string, Row> = {};
let disabled = false;
let issued = 0;
let rotated: string[] = [];
/** Simulates a second request rotating the token between this one's read and its write. */
let loseTheRace = false;

vi.mock("@private-stock/db", () => ({
    userRepo: {
        findById: (id: string) => ({
            id,
            email: "me@example.test",
            displayName: "Me",
            scopes: "",
            disabled: disabled ? 1 : null,
        }),
    },
    refreshTokenRepo: {
        findLive: (token: string) => live[token],
        findRecentlyRotated: (token: string) => recentlyRotated[token],
        issue: () => ({ token: `new-${(issued += 1)}`, expiresAt: new Date() }),
        rotate: (token: string) => {
            if (loseTheRace) return null;

            rotated.push(token);
            delete live[token];

            return { token: `new-${(issued += 1)}`, expiresAt: new Date() };
        },
    },
}));

const { refresh } = await import("./authService");

beforeEach(() => {
    live = {};
    recentlyRotated = {};
    disabled = false;
    issued = 0;
    rotated = [];
    loseTheRace = false;
});

describe("refresh", () => {
    it("rotates a live token", async () => {
        live.current = { userId: "u1" };

        const session = await refresh("current", null);

        expect(rotated).toEqual(["current"]);
        expect(session.refreshToken).toBe("new-1");
        expect(session.user.id).toBe("u1");
    });

    it("lets a token rotated moments ago through, with a token of its own", async () => {
        recentlyRotated.previous = { userId: "u1" };

        const session = await refresh("previous", null);

        // Not rotated again — it is already revoked — but the loser of the race is not signed
        // out either.
        expect(rotated).toEqual([]);
        expect(session.refreshToken).toBe("new-1");
    });

    it("still succeeds when another request rotates the token between read and write", async () => {
        live.current = { userId: "u1" };
        loseTheRace = true;

        await expect(refresh("current", null)).resolves.toMatchObject({ refreshToken: "new-1" });
    });

    it("refuses a token that is neither live nor recently rotated", async () => {
        await expect(refresh("signed-out", null)).rejects.toThrow(AuthenticationError);
        expect(issued).toBe(0);
    });

    it("refuses a disabled account, even inside the grace", async () => {
        recentlyRotated.previous = { userId: "u1" };
        disabled = true;

        await expect(refresh("previous", null)).rejects.toThrow(AuthenticationError);
        expect(issued).toBe(0);
    });
});
