import { afterEach, describe, expect, it, vi } from "vitest";

import { collectGarbage } from "./memory.js";

/**
 * The worker's timed full collection (§20 "The worker's own memory"): it runs when the process
 * has `gc`, and is a no-op rather than an error when it does not -- a development run started
 * without `--expose-gc` must behave exactly as before.
 */

const original = globalThis.gc;

afterEach(() => {
    globalThis.gc = original;
});

describe("collectGarbage", () => {
    it("runs a full collection when the process exposes one", () => {
        const gc = vi.fn();
        globalThis.gc = gc as unknown as typeof globalThis.gc;

        expect(collectGarbage()).toBe(true);
        expect(gc).toHaveBeenCalledTimes(1);
    });

    it("does nothing without --expose-gc", () => {
        globalThis.gc = undefined;

        expect(collectGarbage()).toBe(false);
    });
});
