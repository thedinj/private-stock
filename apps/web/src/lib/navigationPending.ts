import { useSyncExternalStore } from "react";

/**
 * Whether an in-app link has been followed and its page has not rendered yet (§14, "Waiting").
 *
 * `PageTurn` is the one place that decides which clicks are navigations, so it is the one that
 * says when one starts; the address it watches changing is when one ends. The store is outside
 * React because the click is: nothing has re-rendered when a link is followed.
 *
 * A navigation that never lands -- a link to the page you are on that slipped through, a route
 * that errors before rendering -- would hold the bar for ever, so a start lapses on its own.
 */
const LAPSE_MS = 15_000;

let pending = false;
let lapse: number | undefined;
const listeners = new Set<() => void>();

const set = (next: boolean): void => {
    window.clearTimeout(lapse);
    if (next) lapse = window.setTimeout(() => set(false), LAPSE_MS);
    if (pending === next) return;
    pending = next;
    listeners.forEach((listener) => listener());
};

export const navigationStarted = (): void => set(true);

export const navigationSettled = (): void => set(false);

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const useNavigationPending = (): boolean =>
    useSyncExternalStore(
        subscribe,
        () => pending,
        () => false
    );
