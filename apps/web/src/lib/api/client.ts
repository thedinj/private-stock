"use client";

import { loginResponseSchema, type LoginResponse, type SessionUser } from "@private-stock/core";

/**
 * The browser-side API client.
 *
 * The access token is held in memory only — never `localStorage`. The refresh cookie is
 * HttpOnly and does the work of surviving a reload, which means a script injected into the
 * page cannot read a long-lived credential. Losing the access token on refresh is the point,
 * not a limitation.
 */

let accessToken: string | null = null;
let currentUser: SessionUser | null = null;

/**
 * In-flight refresh, shared.
 *
 * A grid that fires twelve requests when the token expires would otherwise start twelve
 * refreshes, each rotating the cookie the next one presents. Collapsing them into one promise
 * keeps that to one rotation per tab; `withRefreshLock` does the same across tabs.
 */
let refreshInFlight: Promise<boolean> | null = null;

/** Told when a refresh is refused, so the shell can leave rather than keep asking. */
const signedOutListeners = new Set<() => void>();

export const getCurrentUser = (): SessionUser | null => currentUser;

export const setSession = (session: LoginResponse | null): void => {
    accessToken = session?.accessToken ?? null;
    currentUser = session?.user ?? null;
};

/**
 * Re-read who we are, without touching the tokens.
 *
 * `setSession` cannot do this: it takes a whole `LoginResponse` and would clear the access
 * token on the way past. The two are separate because the identity can change under a session
 * that is still perfectly valid -- an administrator renaming an account, or granting it a
 * scope -- and re-authenticating to notice would sign the person out to tell them their name
 * had changed.
 *
 * `/api/auth/me` reads the `User` row rather than the token's claims, which is what makes it
 * the answer here: the token still carries the name and scopes it was minted with.
 */
export const fetchCurrentUser = async (): Promise<SessionUser | null> => {
    try {
        currentUser = await api<SessionUser>("/api/auth/me");
    } catch {
        // Leaves the previous value in place. A failed read is not evidence of a changed
        // identity, and blanking the name would put "Account" at the foot of the rail because
        // the network blinked.
        return currentUser;
    }

    return currentUser;
};

export interface ApiIssue {
    path: string;
    message: string;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly requestId?: string,
        /** Field-level validation detail, when the server sent any. */
        readonly issues?: ApiIssue[]
    ) {
        super(message);
        this.name = "ApiError";
    }

    /**
     * A message worth showing someone.
     *
     * "Request failed validation" tells a user nothing they can act on — the server already
     * says *which* field and *why*, and throwing that away is what turns a typo into a
     * guessing game. Field errors are surfaced next to their inputs where possible; this is
     * the fallback for everything else.
     */
    get displayMessage(): string {
        if (!this.issues?.length) {
            return this.message;
        }

        return this.issues.map((issue) => issue.message).join(". ");
    }

    /** Issues keyed by field, for attaching to form inputs. */
    get fieldErrors(): Record<string, string> {
        return Object.fromEntries(
            (this.issues ?? [])
                .filter((issue) => issue.path)
                .map((issue) => [issue.path, issue.message])
        );
    }
}

const parseError = async (response: Response): Promise<ApiError> => {
    try {
        const body = (await response.json()) as {
            code?: string;
            message?: string;
            requestId?: string;
            issues?: ApiIssue[];
        };

        return new ApiError(
            response.status,
            body.code ?? "UNKNOWN",
            body.message ?? response.statusText,
            body.requestId,
            body.issues
        );
    } catch {
        return new ApiError(response.status, "UNKNOWN", response.statusText);
    }
};

/**
 * Leave the shell when the session is refused, rather than keep asking.
 *
 * Without it a refused refresh left the page looking signed in, and every query that ran
 * afterwards — a refetch on focus, a poll, the stragglers of the burst that noticed the expiry —
 * took its own 401 and started another refresh that was bound to be refused too.
 */
export const onSignedOut = (listener: () => void): (() => void) => {
    signedOutListeners.add(listener);

    return () => {
        signedOutListeners.delete(listener);
    };
};

/**
 * Tabs telling each other about a refresh.
 *
 * Every tab holds its own access token in memory, and the refresh cookie they share rotates on
 * every use. A tab that refreshes posts the result here, so the others take the new access
 * token instead of each rotating the cookie again when theirs expires. The channel is
 * same-origin and held in memory, which keeps the token where it already was: a script that
 * could listen here could as easily call `/api/auth/refresh` itself.
 */
const SESSION_CHANNEL = "private-stock-session";

/** Created on first use; null where the browser has no `BroadcastChannel`. */
let sessionChannel: BroadcastChannel | null | undefined;

const adoptBroadcast = (data: unknown): void => {
    const parsed = loginResponseSchema.safeParse(data);

    if (!parsed.success) {
        return;
    }

    // A tab waiting on a refresh takes whatever it is offered: the cookie behind it is the one
    // it would have presented. A settled tab takes only a newer token for the account it
    // already shows, so a sign-in elsewhere never swaps the identity under a page that has
    // not been told.
    if (refreshInFlight || currentUser?.id === parsed.data.user.id) {
        setSession(parsed.data);
    }
};

const channel = (): BroadcastChannel | null => {
    if (sessionChannel === undefined) {
        sessionChannel =
            typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SESSION_CHANNEL);
        sessionChannel?.addEventListener("message", (event: MessageEvent<unknown>) =>
            adoptBroadcast(event.data)
        );
    }

    return sessionChannel;
};

const REFRESH_LOCK = "private-stock-refresh";

/**
 * How long a tab waits for another tab's refresh before going ahead without the lock.
 *
 * Longer than one refresh with all its retries (about seven seconds plus the requests), so it
 * only fires when the tab holding the lock has stopped — and going ahead then costs no more
 * than the server's rotation grace already allows for.
 */
const REFRESH_LOCK_WAIT_MS = 15_000;

/**
 * One refresh at a time across every tab of this origin.
 *
 * The cookie jar is shared and the rotation is not. Two tabs refreshing together send the same
 * cookie, and the second is let through only by the server's grace (§12). Holding a Web Lock
 * around the exchange means the second tab's request leaves after the first tab's `Set-Cookie`
 * has landed, so it carries the new cookie — or, having heard the first tab's broadcast while
 * it waited, does not leave at all.
 *
 * Web Locks need a secure context, and the app is also used over plain HTTP on the LAN. There,
 * and in browsers without the API, each tab refreshes on its own and the grace covers the race
 * exactly as it did before.
 */
const withRefreshLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const locks: LockManager | undefined =
        typeof navigator === "undefined" ? undefined : navigator.locks;

    if (!locks) {
        return work();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_LOCK_WAIT_MS);
    let granted = false;

    try {
        return await locks.request(REFRESH_LOCK, { signal: controller.signal }, () => {
            granted = true;
            clearTimeout(timer);

            return work();
        });
    } catch (error) {
        if (granted) {
            throw error;
        }

        // Waited too long, or the lock manager refused: refresh without it.
        return work();
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Waits between refresh attempts that failed for a reason other than the session.
 *
 * About seven seconds in all: enough to outlast a dev server recompiling or restarting, and a
 * worker holding the database's write lock, without leaving somebody watching a loader for long
 * when the server is genuinely down.
 */
const REFRESH_RETRY_DELAYS_MS = [500, 1_500, 5_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The exchange itself: the refresh cookie for an access token.
 *
 * **Only a 401 means signed out.** Anything else — the network dropping, the server restarting,
 * a 5xx while the database is busy, a 429 — says nothing about the session, and treating it as
 * a sign-out sent people to the login page with a perfectly good cookie. Those are retried, and
 * only if every attempt fails does this give up.
 */
const exchangeRefreshCookie = async (): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const response = await fetch("/api/auth/refresh", {
                method: "POST",
                credentials: "include",
            });

            if (response.ok) {
                const session = (await response.json()) as LoginResponse;
                setSession(session);
                channel()?.postMessage(session);

                return true;
            }

            if (response.status === 401) {
                setSession(null);
                signedOutListeners.forEach((listener) => listener());

                return false;
            }
        } catch {
            // A network failure: retried below, like a server error.
        }

        if (attempt >= REFRESH_RETRY_DELAYS_MS.length) {
            setSession(null);
            return false;
        }

        await sleep(REFRESH_RETRY_DELAYS_MS[attempt]);
    }
};

/**
 * Exchange the refresh cookie for an access token: once at a time within a tab
 * (`refreshInFlight`), and one tab at a time (`withRefreshLock`).
 */
export const refreshSession = async (): Promise<boolean> => {
    if (!refreshInFlight) {
        // Listening from the first refresh on, which every tab makes as it loads.
        channel();

        const stale = accessToken;

        refreshInFlight = (async () => {
            try {
                return await withRefreshLock(async () => {
                    // Another tab refreshed while this one waited for the lock, and said so.
                    if (accessToken !== null && accessToken !== stale) {
                        return true;
                    }

                    return exchangeRefreshCookie();
                });
            } finally {
                // Cleared in a microtask so concurrent callers all observe the same promise.
                queueMicrotask(() => {
                    refreshInFlight = null;
                });
            }
        })();
    }

    return refreshInFlight;
};

export interface ApiOptions extends RequestInit {
    /** Internal: prevents an infinite retry loop when the refresh itself 401s. */
    skipRetry?: boolean;
}

export const api = async <T>(path: string, options: ApiOptions = {}): Promise<T> => {
    const { skipRetry, ...init } = options;

    const headers = new Headers(init.headers);
    const sent = accessToken;

    if (sent) {
        headers.set("Authorization", `Bearer ${sent}`);
    }

    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const response = await fetch(path, { ...init, headers, credentials: "include" });

    if (response.status === 401 && !skipRetry) {
        // The access token is short-lived by design (§ auth), so a 401 mid-session is
        // expected rather than exceptional — refresh once and replay.
        //
        // Unless the token has already changed since this request left: a slow request that
        // set out with the old token answers after the refresh that replaced it has finished
        // and let go of `refreshInFlight`, and asking again would rotate the cookie a second
        // time for nothing. The same holds for a token another tab handed over.
        const renewed = accessToken !== null && accessToken !== sent;

        if (renewed || (await refreshSession())) {
            return api<T>(path, { ...options, skipRetry: true });
        }
    }

    if (!response.ok) {
        throw await parseError(response);
    }

    if (response.status === 204) {
        return undefined as T;
    }

    return (await response.json()) as T;
};

export const login = async (email: string, password: string): Promise<SessionUser> => {
    const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
        throw await parseError(response);
    }

    const session = (await response.json()) as LoginResponse;
    setSession(session);

    return session.user;
};

export const logout = async (): Promise<void> => {
    try {
        await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
        setSession(null);
    }
};
