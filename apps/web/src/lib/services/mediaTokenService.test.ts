import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@private-stock/core";

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

const segmentPlaylist = vi.fn();

vi.mock("./segmentService", () => ({
    segmentPlaylist: (...args: unknown[]) => segmentPlaylist(...args),
}));

const SECRET = "test-secret-value-that-is-long-enough";
const config: { secret: string; castOrigin: string | null } = { secret: SECRET, castOrigin: null };

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => config,
    resolveSecret: (loaded: { secret: string }) => loaded.secret,
}));

const { issueCastTokens, issueMediaToken } = await import("./mediaTokenService");
const { verifyMediaToken, MEDIA_TOKEN_TTL_SECONDS } = await import("../auth/tokens");

const AUTH = {
    userId: "user-1",
    email: "a@b.c",
    displayName: "Viewer",
    scopes: [],
    accessibleRootIds: ["root-1"],
    tokenEpoch: 7,
} as unknown as AuthContext;

const MP4 = {
    absolutePath: "/media/a.mp4",
    relPath: "a.mp4",
    sizeBytes: 1,
    segments: false,
    kind: "video",
};

beforeEach(() => {
    resolveMediaFile.mockReset();
    resolveMediaFile.mockReturnValue(MP4);
    segmentPlaylist.mockReset();
    segmentPlaylist.mockReturnValue(null);
    config.castOrigin = null;
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

    it("links an outside player to the original, which it may play when no browser can", () => {
        const { path } = issueMediaToken("media-1", AUTH, { original: true });

        // Not the cast check: VLC plays what a TV and a browser do not (§8).
        expect(resolveMediaFile).toHaveBeenCalledWith("media-1", AUTH, { original: true });
        expect(path).toMatch(/\/stream\?t=[^&]+&raw=1$/);
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

describe("where a TV is sent", () => {
    /**
     * The LAN install's page sits behind a private certificate a TV will not accept, so the
     * cast link goes to the token-only HTTP port the operator configured — never to a host
     * read from the request.
     */
    it("joins the configured cast origin to the path", () => {
        config.castOrigin = "http://192.168.1.10:8843";
        const issued = issueMediaToken("media-1", AUTH);

        expect(issued.url).toBe(`http://192.168.1.10:8843${issued.path}`);
    });

    it("leaves the URL to the browser when no cast origin is configured", () => {
        expect(issueMediaToken("media-1", AUTH).url).toBeNull();
    });

    it("does not send an outside player's link to the cast port", () => {
        config.castOrigin = "http://192.168.1.10:8843";

        expect(issueMediaToken("media-1", AUTH, { original: true }).url).toBeNull();
    });

    it("names the type the stream route will answer with", () => {
        expect(issueMediaToken("media-1", AUTH).contentType).toBe("video/mp4");

        resolveMediaFile.mockReturnValue({ ...MP4, relPath: "a.ts", segments: true });
        segmentPlaylist.mockReturnValue("#EXTM3U");
        expect(issueMediaToken("media-1", AUTH).contentType).toBe("application/vnd.apple.mpegurl");

        // No index yet: the route serves the bytes, so that is what the TV is told.
        segmentPlaylist.mockReturnValue(null);
        expect(issueMediaToken("media-1", AUTH).contentType).toBe("video/mp2t");
    });
});

describe("issuing a queue's links", () => {
    it("binds each link to its own item, in the order asked", () => {
        const { links } = issueCastTokens(["a", "b"], AUTH);

        expect(links.map((link) => link.mediaId)).toEqual(["a", "b"]);
        expect(links.map((link) => verifyMediaToken(link.token)?.mediaId)).toEqual(["a", "b"]);
    });

    /**
     * Not playable and not visible are dropped alike: the answer must not tell a user which
     * ids exist in a library they cannot reach.
     */
    it("skips what cannot be cast without saying why", () => {
        resolveMediaFile.mockImplementation((id: string) => {
            if (id === "hidden") throw new NotFoundError("Media not found");
            if (id === "pending") throw new ConflictError("No playable version");

            return MP4;
        });

        const { links } = issueCastTokens(["a", "hidden", "pending", "b"], AUTH);

        expect(links.map((link) => link.mediaId)).toEqual(["a", "b"]);
    });

    it("leaves pictures out of a TV's queue", () => {
        resolveMediaFile.mockImplementation((id: string) =>
            id === "still" ? { ...MP4, relPath: "a.jpg", kind: "image" } : MP4
        );

        expect(issueCastTokens(["a", "still"], AUTH).links.map((link) => link.mediaId)).toEqual([
            "a",
        ]);
    });

    it("fails on anything that is not a refusal", () => {
        resolveMediaFile.mockImplementation(() => {
            throw new TypeError("disk on fire");
        });

        expect(() => issueCastTokens(["a"], AUTH)).toThrow(TypeError);
    });
});
