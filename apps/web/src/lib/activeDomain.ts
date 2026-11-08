import { DEFAULT_DOMAIN, LEGACY_DOMAIN, parseDomain, type DomainKind } from "@private-stock/core";

/**
 * Which domain this tab is in (§21 "Which room a browser opens in").
 *
 * Two copies, for two questions:
 *
 *   - `localStorage` is the browser's: the room it was last in, so a browser opened tomorrow
 *     goes back to where it was.
 *   - `sessionStorage` is the tab's, so two tabs can sit in two rooms and a reload keeps the
 *     tab where it was rather than following whichever tab moved last.
 *
 * A browser with neither opens in the family room (`DEFAULT_DOMAIN`), never the cellar.
 *
 * Read once per page load and held. Changing room reloads the page (`switchDomain`), which is
 * what empties every cache, query and live stream that belonged to the old room — there is no
 * in-place switch for a stale response to land in.
 *
 * Every access is wrapped: storage that throws (private mode, blocked site data) leaves the tab
 * in the default room, which is the safe one.
 */

const KEY = "ps:domain";

/** Whether this tab has entered a guarded room's PIN since it opened (§21). */
const PASSED_KEY = "ps:domain:passed";

const readFrom = (storage: () => Storage, key: string): string | null => {
    try {
        return storage().getItem(key);
    } catch {
        return null;
    }
};

const writeTo = (storage: () => Storage, key: string, value: string | null): void => {
    try {
        if (value === null) {
            storage().removeItem(key);
        } else {
            storage().setItem(key, value);
        }
    } catch {
        // Nowhere to keep it; the next load opens in the default room.
    }
};

const local = () => window.localStorage;
const session = () => window.sessionStorage;

let current: DomainKind | null = null;

export const getActiveDomain = (): DomainKind => {
    if (current === null) {
        current =
            typeof window === "undefined"
                ? DEFAULT_DOMAIN
                : (parseDomain(readFrom(session, KEY)) ??
                  parseDomain(readFrom(local, KEY)) ??
                  DEFAULT_DOMAIN);
    }

    return current;
};

/**
 * A browser-storage key for something that belongs to the room this tab is in (§21).
 *
 * The Cellar keeps the bare key, so what was remembered before there were rooms -- all of it the
 * Cellar's -- is still found there; every other room gets its own.
 */
export const roomKey = (key: string): string => {
    const domain = getActiveDomain();

    return domain === LEGACY_DOMAIN ? key : `${key}@${domain}`;
};

/**
 * Move this tab to another room, and make it the room this browser reopens in.
 *
 * A reload to the home page, on purpose: the page being shown belongs to the old room, and so
 * does everything cached for it.
 *
 * **The tab's own storage is emptied first.** It survives a reload, and everything in it is
 * about where this tab has been: the list an item returns to, a selection, a showcase or tasting
 * to resume, dupe choices. All of it belongs to the room being left, and none of it is worth
 * carrying through the door. Clearing all of it, rather than naming each key, means a key added
 * later cannot forget to be cleared.
 */
export const switchDomain = (next: DomainKind): void => {
    try {
        window.sessionStorage.clear();
    } catch {
        // Nothing reachable to carry over either.
    }
    writeTo(session, KEY, next);
    writeTo(local, KEY, next);
    writeTo(session, PASSED_KEY, null);
    window.location.assign("/");
};

export const hasPassedGate = (domain: DomainKind): boolean =>
    readFrom(session, PASSED_KEY) === domain;

export const markGatePassed = (domain: DomainKind): void => {
    writeTo(session, PASSED_KEY, domain);
};
