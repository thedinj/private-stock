import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signed media tokens (§12d).
 *
 * The claims worth proving are all about confinement. A media token is the one credential
 * this app hands to something that is not the browser, so what matters is that it buys
 * exactly one item, that it cannot be turned back into a session, and that it stops working
 * the moment the account's access does — without waiting out its own expiry.
 */

const SECRET = "test-secret-value-that-is-long-enough";

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ secret: SECRET }),
    resolveSecret: (config: { secret: string }) => config.secret,
}));

let users: Record<
    string,
    {
        id: string;
        email: string;
        displayName: string;
        scopes: string;
        disabled: number | null;
        tokenEpoch: number;
    }
> = {};
let accessibleRoots: string[] = [];
/** How many times the user row was actually read — the auth cache's whole purpose. */
let userReads = 0;
let liveRefreshTokens: Record<string, string> = {};

vi.mock("@private-stock/db", () => ({
    userRepo: {
        findById: (id: string) => {
            userReads += 1;
            return users[id];
        },
    },
    mediaRootRepo: {
        accessibleRootIds: () => accessibleRoots,
    },
    refreshTokenRepo: {
        findLive: (token: string) =>
            liveRefreshTokens[token] ? { userId: liveRefreshTokens[token] } : undefined,
    },
}));

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
    cookies: async () => ({
        get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined),
    }),
}));

const {
    signAccessToken,
    signMediaToken,
    verifyMediaToken,
    verifyAccessToken,
    MEDIA_TOKEN_TTL_SECONDS,
} = await import("./tokens");
const { requireMediaAuth, corsHeadersFor } = await import("./withAuth");
const { REFRESH_COOKIE } = await import("./cookies");
const { forgetAuth } = await import("./authCache");

const USER = "user-1";
const MEDIA = "media-1";

const request = (url: string, headers: Record<string, string> = {}): Request =>
    new Request(url, { headers });

beforeEach(() => {
    users = {
        [USER]: {
            id: USER,
            email: "a@b.c",
            displayName: "Viewer",
            scopes: "delete",
            disabled: null,
            tokenEpoch: 3,
        },
    };
    accessibleRoots = ["root-1"];
    liveRefreshTokens = {};
    cookieJar = {};
    userReads = 0;
    forgetAuth();
});

describe("what a media token is good for", () => {
    it("admits a request for the item it names", async () => {
        const token = signMediaToken(USER, MEDIA, 3);

        const { auth, via } = await requireMediaAuth(
            request(`http://host/api/media/${MEDIA}/stream?t=${token}`),
            MEDIA
        );

        expect(auth.userId).toBe(USER);
        expect(via).toBe("token");
    });

    /**
     * The binding is the entire feature.
     *
     * Without this check a token minted for one file would read every other, which would make
     * it a second session credential that happens to live in a URL — the thing it exists to
     * avoid.
     */
    it("refuses a request for a different item", async () => {
        const token = signMediaToken(USER, MEDIA, 3);

        await expect(
            requireMediaAuth(request(`http://host/api/media/other/stream?t=${token}`), "other")
        ).rejects.toThrow(/sign in/i);
    });

    /**
     * A mis-scoped token must not quietly succeed because a browser happened to be signed in.
     *
     * Falling through to the cookie would serve the bytes anyway, and the token would look
     * like it worked — so the binding would go untested until the day something without a
     * cookie tried it.
     */
    it("does not fall back to the cookie when the token is wrong", async () => {
        liveRefreshTokens["live"] = USER;
        cookieJar[REFRESH_COOKIE] = "live";

        await expect(
            requireMediaAuth(request(`http://host/api/media/${MEDIA}/stream?t=nonsense`), MEDIA)
        ).rejects.toThrow(/sign in/i);
    });

    it("refuses a token signed with a different secret", async () => {
        const jwt = (await import("jsonwebtoken")).default;
        const forged = jwt.sign({ mediaId: MEDIA, epoch: 3, purpose: "media" }, "not-the-secret", {
            subject: USER,
            algorithm: "HS256",
        });

        expect(verifyMediaToken(forged)).toBeNull();
    });

    it("expires", async () => {
        const jwt = (await import("jsonwebtoken")).default;
        const stale = jwt.sign({ mediaId: MEDIA, epoch: 3, purpose: "media" }, SECRET, {
            subject: USER,
            algorithm: "HS256",
            expiresIn: -1,
        });

        expect(verifyMediaToken(stale)).toBeNull();
    });

    it("lasts a day, long enough to finish a film without a refresh flow", () => {
        expect(MEDIA_TOKEN_TTL_SECONDS).toBe(24 * 60 * 60);
    });
});

/**
 * The two token kinds must not be interchangeable.
 *
 * An access token carries scopes and belongs in a header; a media token carries an item and
 * belongs in a URL, where it will be logged by proxies and kept in device history. Each being
 * unusable as the other is what keeps a leaked URL from becoming a session.
 */
describe("the two token kinds", () => {
    it("does not accept an access token as a media token", () => {
        expect(verifyMediaToken(signAccessToken(USER, ["admin"]))).toBeNull();
    });

    it("does not accept a media token as an access token", () => {
        expect(verifyAccessToken(signMediaToken(USER, MEDIA, 3))).toBeNull();
    });

    it("ignores a media token presented in the Authorization header", async () => {
        const token = signMediaToken(USER, MEDIA, 3);

        // No cookie either, so the only credential offered is the one in the header.
        await expect(
            requireMediaAuth(
                request(`http://host/api/media/${MEDIA}/stream`, {
                    authorization: `Bearer ${token}`,
                }),
                MEDIA
            )
        ).rejects.toThrow(/sign in/i);
    });
});

/**
 * A token names a user; it never carries their permissions.
 *
 * This is what makes revocation immediate. If the token cached scopes or root access, an
 * admin withdrawing a library would wait up to a day for it to take effect, and there would
 * be no way to find out which tokens were still outstanding.
 */
describe("authorization is re-read, never carried", () => {
    it("stops working when the account is disabled", async () => {
        const token = signMediaToken(USER, MEDIA, 3);
        users[USER].disabled = 1;

        await expect(
            requireMediaAuth(request(`http://host/api/media/${MEDIA}/stream?t=${token}`), MEDIA)
        ).rejects.toThrow(/sign in/i);
    });

    it("reflects root access as it stands now, not as it stood when signed", async () => {
        const token = signMediaToken(USER, MEDIA, 3);
        accessibleRoots = [];

        const { auth } = await requireMediaAuth(
            request(`http://host/api/media/${MEDIA}/stream?t=${token}`),
            MEDIA
        );

        // The identity still verifies; the access check downstream is what now finds nothing.
        expect(auth.accessibleRootIds).toEqual([]);
    });

    /**
     * Changing a password kills every outstanding signed URL.
     *
     * The alternative — waiting out the token's own lifetime — would leave up to a day in
     * which the thing the user just did to lock someone out had not yet done so.
     */
    it("stops working once the password has changed", async () => {
        const token = signMediaToken(USER, MEDIA, 3);
        users[USER].tokenEpoch = 4;

        await expect(
            requireMediaAuth(request(`http://host/api/media/${MEDIA}/stream?t=${token}`), MEDIA)
        ).rejects.toThrow(/sign in/i);
    });

    /**
     * Equality, not ordering. The epoch is an opaque generation counter, so a token claiming
     * a newer one is as wrong as one claiming an older — and treating it as a floor would
     * make a forged high value indefinitely valid.
     */
    it("refuses a token claiming an epoch ahead of the account's", async () => {
        const token = signMediaToken(USER, MEDIA, 99);

        await expect(
            requireMediaAuth(request(`http://host/api/media/${MEDIA}/stream?t=${token}`), MEDIA)
        ).rejects.toThrow(/sign in/i);
    });

    it("carries the user's current scopes rather than none", async () => {
        const token = signMediaToken(USER, MEDIA, 3);

        const { auth } = await requireMediaAuth(
            request(`http://host/api/media/${MEDIA}/stream?t=${token}`),
            MEDIA
        );

        expect(auth.scopes).toEqual(["delete"]);
    });
});

/**
 * The cache in front of all of the above (§20).
 *
 * Cookie authentication used to cost four statements per request, and a grid is sixty image
 * requests at once. The owner traded instant effect for changes made *outside* the app — they
 * now land within a minute — and kept it for everything the app itself changes, because those
 * services empty the cache.
 */
describe("the auth cache", () => {
    const cookieRequest = () => {
        liveRefreshTokens["live"] = USER;
        cookieJar[REFRESH_COOKIE] = "live";

        return requireMediaAuth(request(`http://host/api/art/${MEDIA}/cover`), MEDIA);
    };

    it("reads the account once for a burst of requests", async () => {
        for (let i = 0; i < 60; i++) {
            await cookieRequest();
        }

        expect(userReads).toBe(1);
    });

    it("applies a change made through the app at once", async () => {
        await cookieRequest();

        users[USER].disabled = 1;
        forgetAuth(); // What `userAdminService` does after disabling someone.

        await expect(cookieRequest()).rejects.toThrow(/sign in/i);
    });

    it("applies a change made elsewhere within a minute", async () => {
        vi.useFakeTimers();

        try {
            await cookieRequest();
            users[USER].disabled = 1;

            // Not yet: this is the trade, and it is only for changes the app did not make.
            await expect(cookieRequest()).resolves.toBeDefined();

            vi.advanceTimersByTime(60_001);

            await expect(cookieRequest()).rejects.toThrow(/sign in/i);
        } finally {
            vi.useRealTimers();
        }
    });

    it("never keeps a refusal, so a repaired account works on its next request", async () => {
        users[USER].disabled = 1;
        await expect(cookieRequest()).rejects.toThrow(/sign in/i);

        users[USER].disabled = null;

        await expect(cookieRequest()).resolves.toBeDefined();
    });

    it("still refuses a stale media token when the account is cached", async () => {
        await cookieRequest();

        const stale = signMediaToken(USER, MEDIA, 2);

        await expect(
            requireMediaAuth(request(`http://host/api/media/${MEDIA}/stream?t=${stale}`), MEDIA)
        ).rejects.toThrow(/sign in/i);
    });
});

describe("the other two credentials still work", () => {
    it("accepts a Bearer access token", async () => {
        const { via } = await requireMediaAuth(
            request(`http://host/api/media/${MEDIA}/stream`, {
                authorization: `Bearer ${signAccessToken(USER, [])}`,
            }),
            MEDIA
        );

        expect(via).toBe("header");
    });

    it("accepts the refresh cookie, which is how <video> and <img> get in", async () => {
        liveRefreshTokens["live"] = USER;
        cookieJar[REFRESH_COOKIE] = "live";

        const { via } = await requireMediaAuth(
            request(`http://host/api/media/${MEDIA}/stream`),
            MEDIA
        );

        expect(via).toBe("cookie");
    });

    it("refuses a request carrying nothing at all", async () => {
        await expect(
            requireMediaAuth(request(`http://host/api/media/${MEDIA}/stream`), MEDIA)
        ).rejects.toThrow(/sign in/i);
    });
});

/**
 * The reason `via` is returned at all.
 *
 * `Allow-Origin: *` on a cookie-authenticated response would let any page in the browser read
 * the user's library cross-origin, using authority the browser attaches by itself. With a
 * token there is no ambient credential to borrow — the caller had to be handed the URL.
 */
describe("cross-origin access", () => {
    it("opens up only for a token-authenticated request", () => {
        expect(corsHeadersFor("token")["Access-Control-Allow-Origin"]).toBe("*");
        expect(corsHeadersFor("cookie")).toEqual({});
        expect(corsHeadersFor("header")).toEqual({});
    });

    it("never pairs a wildcard origin with credentials", () => {
        expect(corsHeadersFor("token")["Access-Control-Allow-Credentials"]).toBeUndefined();
    });

    it("exposes the range headers a receiver needs to seek", () => {
        expect(corsHeadersFor("token")["Access-Control-Expose-Headers"]).toContain("Content-Range");
    });
});
