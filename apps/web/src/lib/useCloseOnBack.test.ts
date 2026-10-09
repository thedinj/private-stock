import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Back closes overlays, through one shared history entry (§14): handing one overlay over to
 * another in the same render must not close the second.
 */

/** A browser's history, enough of it: `back()` is asynchronous, as it is in a browser. */
const fakeWindow = () => {
    const entries: unknown[] = [null];
    let index = 0;
    const listeners = new Set<() => void>();

    const win = {
        history: {
            get state() {
                return entries[index];
            },
            get length() {
                return index + 1;
            },
            pushState: (state: unknown) => {
                entries.splice(index + 1, entries.length, state);
                index += 1;
            },
            back: () => {
                setTimeout(() => {
                    index = Math.max(0, index - 1);
                    for (const listener of [...listeners]) listener();
                }, 0);
            },
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    };

    return win;
};

let win: ReturnType<typeof fakeWindow>;

beforeEach(() => {
    vi.useFakeTimers();
    win = fakeWindow();
    vi.stubGlobal("window", win);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const { overlayHistory } = await import("./useCloseOnBack");

describe("closing overlays on Back", () => {
    it("closes what is open when Back is pressed, and leaves the history as it was", async () => {
        const close = { current: vi.fn() };

        overlayHistory.register(close);
        expect(win.history.length).toBe(2);

        win.history.back();
        await vi.runAllTimersAsync();

        expect(close.current).toHaveBeenCalledOnce();
        expect(win.history.length).toBe(1);
    });

    it("takes its entry back off when closed by its own button", async () => {
        const close = { current: vi.fn() };

        overlayHistory.register(close);
        overlayHistory.unregister(close);
        await vi.runAllTimersAsync();

        expect(close.current).not.toHaveBeenCalled();
        expect(win.history.length).toBe(1);
    });

    it("keeps the entry for an overlay that opens as another closes", async () => {
        const look = { current: vi.fn() };
        const drawer = { current: vi.fn() };

        overlayHistory.register(look);
        // "Play it here": the look closes and the drawer opens in one render.
        overlayHistory.unregister(look);
        overlayHistory.register(drawer);
        await vi.runAllTimersAsync();

        expect(drawer.current).not.toHaveBeenCalled();
        expect(win.history.length).toBe(2);

        win.history.back();
        await vi.runAllTimersAsync();

        expect(drawer.current).toHaveBeenCalledOnce();
        expect(look.current).not.toHaveBeenCalled();
        expect(win.history.length).toBe(1);
    });
});
