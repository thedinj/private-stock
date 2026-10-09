import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Minting a signed media URL (§12d).
 *
 * `resolveMediaFile` is mocked here because what this service is responsible for is *which
 * question it asks* — the answering of it belongs to `mediaService` and is tested there. The
 * claims are that it asks for a cast-ready file, that it refuses to sign when the answer is
 * no, and that the epoch it stamps in is the account's current one.
 */

const resolveMediaFile = vi.fn();

vi.mock("./mediaService", () => ({
    resolveMediaFile: (...args: unknown[]) => resolveMediaFile(...args),
}));

const SECRET = "test-secret-value-that-is-long-enough";

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ secret: SECRET }),
    resolveSecret: (config: { secret: string }) => config.secret,
}));

const { issueMediaToken } = await import("./mediaTokenService");
const { verifyMediaToken, MEDIA_TOKEN_TTL_SECONDS } = await import("../auth/tokens");

const AUTH = {
    userId: "user-1",
    email: "a@b.c",
    displayName: "Viewer",
    scopes: [],
    accessibleRootIds: ["root-1"],
    tokenEpoch: 7,
} as unknown as AuthContext;

beforeEach(() => {
    resolveMediaFile.mockReset();
    resolveMediaFile.mockReturnValue({ absolutePath: "/media/a.mp4", sizeBytes: 1 });
});

describe("issuing a token", () => {
    it("binds the token to the item and the account's current epoch", () => {
        const { token } = issueMediaToken("media-1", AUTH);

        expect(verifyMediaToken(token)).toMatchObject({
            sub: "user-1",
            mediaId: "media-1",
            epoch: 7,
            purpose: "media",
        });
    });

    /**
     * A TV has no detail page to explain a failure and no fallback to offer.
     *
     * So the playability question is asked here too, not only when the bytes are requested —
     * a UI finds out before it starts a cast session rather than after the screen goes black.
     */
    it("asks for a cast-ready file", () => {
        issueMediaToken("media-1", AUTH);

        expect(resolveMediaFile).toHaveBeenCalledWith("media-1", AUTH, { requireCastReady: true });
    });

    it("signs nothing when the item cannot be resolved", () => {
        resolveMediaFile.mockImplementation(() => {
            throw new NotFoundError("Media not found");
        });

        expect(() => issueMediaToken("media-1", AUTH)).toThrow(NotFoundError);
    });

    it("hands back a relative path carrying the token, and when it lapses", () => {
        const before = Date.now();
        const issued = issueMediaToken("media-1", AUTH);

        expect(issued.path).toBe(`/api/media/media-1/stream?t=${encodeURIComponent(issued.token)}`);

        const expires = new Date(issued.expiresAt).getTime();

        expect(expires).toBeGreaterThanOrEqual(before + MEDIA_TOKEN_TTL_SECONDS * 1000);
    });

    /**
     * Relative, because the server cannot know what address the TV can reach it on: behind a
     * reverse proxy, `Host` and `X-Forwarded-Host` are whatever the proxy was told to send.
     */
    it("does not guess an origin", () => {
        expect(issueMediaToken("media-1", AUTH).path.startsWith("/")).toBe(true);
    });
});
