import { describe, expect, it } from "vitest";

import { createTtlCache } from "./ttlCache";

describe("createTtlCache", () => {
    it("answers from the cache until the entry expires", () => {
        const cache = createTtlCache<number>(1_000, 10);
        let calls = 0;
        const compute = () => ++calls;

        expect(cache.get("a", compute, 0)).toBe(1);
        expect(cache.get("a", compute, 999)).toBe(1);
        expect(cache.get("a", compute, 1_000)).toBe(2);
    });

    it("drops the oldest entry once the bound is passed", () => {
        const cache = createTtlCache<string>(60_000, 2);

        cache.get("a", () => "a1", 0);
        cache.get("b", () => "b1", 1);
        cache.get("c", () => "c1", 2);

        expect(cache.get("b", () => "b2", 3)).toBe("b1");
        expect(cache.get("c", () => "c2", 3)).toBe("c1");
        expect(cache.get("a", () => "a2", 3)).toBe("a2");
    });

    it("sweeps expired entries ahead of the newest", () => {
        const cache = createTtlCache<string>(10, 5);

        cache.get("a", () => "a1", 0);
        cache.get("b", () => "b1", 20);

        // "a" expired at 10 and was swept by the write at 20, so it is recomputed.
        expect(cache.get("a", () => "a2", 21)).toBe("a2");
        expect(cache.get("b", () => "b2", 21)).toBe("b1");
    });

    it("bounds what the entries weigh, oldest out first", () => {
        const cache = createTtlCache<number[]>(60_000, 10, {
            weigh: (value) => value.length,
            maxWeight: 5,
        });

        cache.get("a", () => [1, 2], 0);
        cache.get("b", () => [1, 2], 1);
        cache.get("c", () => [1, 2], 2);

        // Six would be over five, so "a" went to make room for "c".
        expect(cache.get("a", () => [9], 3)).toEqual([9]);
        expect(cache.get("c", () => [9], 3)).toEqual([1, 2]);
    });

    it("returns a value heavier than the whole budget without keeping it", () => {
        const cache = createTtlCache<number[]>(60_000, 10, {
            weigh: (value) => value.length,
            maxWeight: 2,
        });
        let calls = 0;

        cache.get("small", () => [1], 0);

        expect(cache.get("big", () => (calls++, [1, 2, 3]), 1)).toEqual([1, 2, 3]);
        expect(cache.get("big", () => (calls++, [1, 2, 3]), 2)).toEqual([1, 2, 3]);
        expect(calls).toBe(2);
        // And it evicted nothing on its way through.
        expect(cache.get("small", () => [9], 3)).toEqual([1]);
    });

    it("forgets one entry, or all of them", () => {
        const cache = createTtlCache<string>(60_000, 10);

        cache.get("a", () => "a1", 0);
        cache.get("b", () => "b1", 0);
        cache.delete("a");

        expect(cache.get("a", () => "a2", 1)).toBe("a2");
        expect(cache.get("b", () => "b2", 1)).toBe("b1");

        cache.clear();

        expect(cache.get("b", () => "b3", 2)).toBe("b3");
    });
});
