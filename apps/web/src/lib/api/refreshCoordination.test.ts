import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One refresh at a time, within a tab and across tabs (§12).
 *
 * The refresh cookie rotates on every use and is shared by every tab, so each extra refresh is
 * an extra rotation racing the others. These tests load the client once per simulated tab —
 * each load is a tab's own memory — over one shared lock manager and one shared broadcast bus,
 * which is what the browser gives the real tabs.
 */

type Client = typeof import("./client");

const sessionFor = (accessToken: string, userId = "u-1") => ({
    accessToken,
    expiresInSeconds: 900,
    user: { id: userId, email: "me@example.test", displayName: "Me", scopes: [] as never[] },
});

const reply = (status: number, body: unknown = {}) =>
    Promise.resolve(
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );

/** A promise settled from outside, for holding a response back. */
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });

    return { promise, resolve };
};

/** `BroadcastChannel` as the browser has it: delivered to every other channel of the name. */
class FakeChannel {
    static open = new Set<FakeChannel>();

    private listeners: ((event: { data: unknown }) => void)[] = [];

    constructor(readonly name: string) {
        FakeChannel.open.add(this);
    }

    addEventListener(_type: string, listener: (event: { data: unknown }) => void): void {
        this.listeners.push(listener);
    }

    postMessage(data: unknown): void {
        for (const other of FakeChannel.open) {
            if (other !== this && other.name === this.name) {
                const copy = structuredClone(data);
                queueMicrotask(() =>
                    other.listeners.forEach((listener) => listener({ data: copy }))
                );
            }
        }
    }
}

/** An exclusive lock manager: requests are granted one at a time, in order. */
const fifoLocks = () => {
    let tail: Promise<unknown> = Promise.resolve();

    return {
        request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
            const run = tail.then(() => callback());
            tail = run.catch(() => undefined);

            return run;
        },
    };
};

/** A fresh copy of the client: one tab. */
const openTab = async (): Promise<Client> => {
    vi.resetModules();

    return import("./client");
};

/** Counts refreshes, and how many were ever in flight together. */
const refreshServer = (tokens: string[]) => {
    const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };

    const handle = async () => {
        stats.calls += 1;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);

        // Answering takes a moment, as it does on the NAS.
        await new Promise((resolve) => setTimeout(resolve, 50));

        stats.inFlight -= 1;

        return reply(200, sessionFor(tokens[Math.min(stats.calls, tokens.length) - 1]));
    };

    return { stats, handle };
};

const bearer = (init?: RequestInit) => new Headers(init?.headers).get("Authorization");

beforeEach(() => {
    vi.useFakeTimers();
    FakeChannel.open.clear();
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.stubGlobal("navigator", { locks: fifoLocks() });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("within one tab", () => {
    it("answers a burst of 401s with one refresh, and retries every request with its token", async () => {
        const tab = await openTab();
        tab.setSession(sessionFor("stale"));

        const server = refreshServer(["fresh"]);
        const sentWith: (string | null)[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn((path: string, init?: RequestInit) => {
                if (path === "/api/auth/refresh") return server.handle();

                sentWith.push(bearer(init));

                return bearer(init) === "Bearer fresh" ? reply(200, { path }) : reply(401);
            })
        );

        const results = Promise.all(
            ["/a", "/b", "/c", "/d", "/e"].map((path) => tab.api<{ path: string }>(path))
        );
        await vi.runAllTimersAsync();

        expect((await results).map((result) => result.path)).toEqual([
            "/a",
            "/b",
            "/c",
            "/d",
            "/e",
        ]);
        expect(server.stats.calls).toBe(1);
        expect(sentWith.filter((value) => value === "Bearer fresh")).toHaveLength(5);
    });

    it("does not refresh again for a 401 that arrives after the refresh has finished", async () => {
        const tab = await openTab();
        tab.setSession(sessionFor("stale"));

        const server = refreshServer(["fresh", "fresher"]);
        const slow = deferred<Response>();

        vi.stubGlobal(
            "fetch",
            vi.fn((path: string, init?: RequestInit) => {
                if (path === "/api/auth/refresh") return server.handle();
                if (bearer(init) === "Bearer fresh") return reply(200, { path });

                // The slow request set out with the stale token and answers late.
                return path === "/slow" ? slow.promise : reply(401);
            })
        );

        const fast = tab.api<{ path: string }>("/fast");
        const late = tab.api<{ path: string }>("/slow");

        await vi.runAllTimersAsync();
        expect((await fast).path).toBe("/fast");

        slow.resolve(new Response("{}", { status: 401 }));
        await vi.runAllTimersAsync();

        expect((await late).path).toBe("/slow");
        expect(server.stats.calls).toBe(1);
    });

    it("tells the shell when the session is refused", async () => {
        const tab = await openTab();
        tab.setSession(sessionFor("stale"));

        const signedOut = vi.fn();
        tab.onSignedOut(signedOut);
        vi.stubGlobal(
            "fetch",
            vi.fn(() => reply(401))
        );

        const request = tab.api("/a").catch((error: unknown) => error);
        await vi.runAllTimersAsync();

        expect(await request).toBeInstanceOf(tab.ApiError);
        expect(signedOut).toHaveBeenCalledTimes(1);
        expect(tab.getCurrentUser()).toBeNull();
    });
});

describe("across tabs", () => {
    it("lets one tab refresh while the other waits and takes its token", async () => {
        const first = await openTab();
        const second = await openTab();

        const server = refreshServer(["fresh"]);
        vi.stubGlobal(
            "fetch",
            vi.fn(() => server.handle())
        );

        // Two tabs loading together, as a deploy or a restored browser window makes them.
        const both = Promise.all([first.refreshSession(), second.refreshSession()]);
        await vi.runAllTimersAsync();

        expect(await both).toEqual([true, true]);
        expect(server.stats.calls).toBe(1);
        expect(second.getCurrentUser()?.id).toBe("u-1");
    });

    it("never has two refreshes in flight, even when the broadcast is not heard", async () => {
        // A browser without BroadcastChannel: only the lock is left to keep them apart.
        vi.stubGlobal("BroadcastChannel", undefined);

        const first = await openTab();
        const second = await openTab();

        const server = refreshServer(["fresh", "fresher"]);
        vi.stubGlobal(
            "fetch",
            vi.fn(() => server.handle())
        );

        const both = Promise.all([first.refreshSession(), second.refreshSession()]);
        await vi.runAllTimersAsync();

        expect(await both).toEqual([true, true]);
        expect(server.stats.maxInFlight).toBe(1);
    });

    it("hands a settled tab the newer token, so it does not refresh when its own expires", async () => {
        const first = await openTab();
        const second = await openTab();
        second.setSession(sessionFor("second-old"));

        // The second tab listens once it has made the refresh every tab makes as it loads.
        const server = refreshServer(["second-own", "fresh"]);
        const sentWith: (string | null)[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((path: string, init?: RequestInit) => {
                if (path === "/api/auth/refresh") return server.handle();

                sentWith.push(bearer(init));

                return reply(200, {});
            })
        );

        const loads = second.refreshSession();
        await vi.runAllTimersAsync();
        await loads;

        const refreshes = first.refreshSession();
        await vi.runAllTimersAsync();
        await refreshes;

        const request = second.api("/a");
        await vi.runAllTimersAsync();
        await request;

        expect(sentWith).toEqual(["Bearer fresh"]);
    });

    it("ignores a broadcast for another account in a settled tab", async () => {
        const first = await openTab();
        const second = await openTab();

        let calls = 0;
        const sentWith: (string | null)[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((path: string, init?: RequestInit) => {
                if (path !== "/api/auth/refresh") {
                    sentWith.push(bearer(init));

                    return reply(200, {});
                }

                calls += 1;

                return reply(
                    200,
                    calls === 1 ? sessionFor("mine", "u-1") : sessionFor("theirs", "u-2")
                );
            })
        );

        const loads = second.refreshSession();
        await vi.runAllTimersAsync();
        await loads;

        const elsewhere = first.refreshSession();
        await vi.runAllTimersAsync();
        await elsewhere;

        const request = second.api("/a");
        await vi.runAllTimersAsync();
        await request;

        expect(second.getCurrentUser()?.id).toBe("u-1");
        expect(sentWith).toEqual(["Bearer mine"]);
    });

    it("refreshes without the lock where Web Locks are missing", async () => {
        // Plain HTTP on the LAN is not a secure context, so `navigator.locks` is absent there.
        vi.stubGlobal("navigator", {});

        const tab = await openTab();
        const server = refreshServer(["fresh"]);
        vi.stubGlobal(
            "fetch",
            vi.fn(() => server.handle())
        );

        const result = tab.refreshSession();
        await vi.runAllTimersAsync();

        expect(await result).toBe(true);
        expect(server.stats.calls).toBe(1);
    });

    it("stops waiting for a tab that holds the lock and never lets go", async () => {
        vi.stubGlobal("navigator", {
            locks: {
                request: (_name: string, options: { signal: AbortSignal }) =>
                    new Promise((_resolve, reject) => {
                        options.signal.addEventListener("abort", () =>
                            reject(new DOMException("Aborted", "AbortError"))
                        );
                    }),
            },
        });

        const tab = await openTab();
        const server = refreshServer(["fresh"]);
        vi.stubGlobal(
            "fetch",
            vi.fn(() => server.handle())
        );

        const result = tab.refreshSession();
        await vi.advanceTimersByTimeAsync(14_000);
        expect(server.stats.calls).toBe(0);

        await vi.runAllTimersAsync();

        expect(await result).toBe(true);
        expect(server.stats.calls).toBe(1);
    });
});
