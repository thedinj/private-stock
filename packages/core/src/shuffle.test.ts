import { describe, expect, it } from "vitest";

import {
    primeAbove,
    rowidShuffleParams,
    shuffleExhausted,
    shufflePageSlots,
    shuffleParams,
    shuffleSlot,
} from "./shuffle.js";

/**
 * The one property that matters is bijection: every slot visited exactly once. If it holds,
 * a shuffled library pages correctly and nothing repeats or vanishes; if it fails, the
 * symptom is duplicate and missing items scattered through the shuffle, which looks like a
 * paging bug and is nearly impossible to trace back to arithmetic.
 *
 * So it is tested exhaustively at small sizes and statistically at realistic ones.
 */

describe("primeAbove", () => {
    it("returns the next prime", () => {
        expect(primeAbove(1)).toBe(2);
        expect(primeAbove(2)).toBe(3);
        expect(primeAbove(10)).toBe(11);
        expect(primeAbove(200_000)).toBe(200_003);
    });

    it("is strictly greater, so every rowid has a slot", () => {
        // If it returned the input when the input is prime, the highest rowid would map to
        // slot 0 and never be reachable.
        expect(primeAbove(11)).toBeGreaterThan(11);
        expect(primeAbove(7)).toBe(11);
    });

    it("copes with an empty library", () => {
        expect(primeAbove(0)).toBe(2);
    });
});

describe("shuffleSlot", () => {
    it("is a permutation: every slot exactly once", () => {
        // Exhaustive, at a size where exhaustive is possible.
        const params = shuffleParams(42, 100);
        const seen = new Set<number>();

        for (let i = 0; i < params.prime; i += 1) {
            seen.add(shuffleSlot(i, params));
        }

        expect(seen.size).toBe(params.prime);
    });

    it("is a permutation for many different seeds", () => {
        for (let seed = 0; seed < 50; seed += 1) {
            const params = shuffleParams(seed, 60);
            const seen = new Set<number>();

            for (let i = 0; i < params.prime; i += 1) {
                seen.add(shuffleSlot(i, params));
            }

            expect({ seed, size: seen.size }).toEqual({ seed, size: params.prime });
        }
    });

    it("stays exact at a library size where doubles would not", () => {
        /**
         * The reason the multiply is BigInt. With a large prime and a large multiplier, the
         * product passes 2^53 and double arithmetic silently drops low bits -- the map keeps
         * returning plausible slot numbers and quietly stops being a bijection.
         */
        const params = shuffleParams(7, 50_000_000);
        const seen = new Set<number>();

        for (let i = 0; i < 20_000; i += 1) {
            const slot = shuffleSlot(i, params);

            expect(Number.isSafeInteger(slot)).toBe(true);
            seen.add(slot);
        }

        expect(seen.size).toBe(20_000);
    });

    it("never produces a slot outside the prime", () => {
        const params = shuffleParams(3, 1_000);

        for (let i = 0; i < 5_000; i += 1) {
            const slot = shuffleSlot(i, params);

            expect(slot).toBeGreaterThanOrEqual(0);
            expect(slot).toBeLessThan(params.prime);
        }
    });
});

describe("rowidShuffleParams", () => {
    /**
     * Sized to the library, the prime moved whenever a scan added items, and the same seed
     * became a different order: a shuffle you left was not the one you came back to.
     */
    it("is the same permutation however large the library grows", () => {
        expect(rowidShuffleParams(42)).toEqual(rowidShuffleParams(42));
        expect(rowidShuffleParams(42).prime).toBe(2_147_483_647);
    });

    it("keeps the sort expression inside SQLite's 64-bit integers", () => {
        // Past 2^63 SQLite silently switches to floating point and the order stops being a
        // permutation. The largest rowid the range admits is prime - 1.
        for (const seed of [1, 999_999, 123_456]) {
            const { a, b, prime } = rowidShuffleParams(seed);

            expect(BigInt(a) * BigInt(prime - 1) + BigInt(b)).toBeLessThan(2n ** 63n);
        }
    });
});

describe("shuffleParams", () => {
    it("is stable for a seed", () => {
        expect(shuffleParams(9, 1_000)).toEqual(shuffleParams(9, 1_000));
    });

    it("gives unrelated orders for consecutive seeds", () => {
        // A reshuffle button produces consecutive seeds. Without mixing, seed n+1 would be
        // seed n shifted by one row, which does not read as a reshuffle at all.
        const first = shufflePageSlots(0, 20, 1_000, shuffleParams(1, 1_000)).slice(0, 20);
        const second = shufflePageSlots(0, 20, 1_000, shuffleParams(2, 1_000)).slice(0, 20);

        const overlap = first.filter((slot, index) => slot === second[index]).length;

        expect(overlap).toBeLessThan(5);
    });

    it("never produces a multiplier that collapses the map", () => {
        // a = 0 sends every index to the same slot: one item, rendered forever.
        for (let seed = 0; seed < 200; seed += 1) {
            const params = shuffleParams(seed, 500);

            expect(params.a % params.prime).not.toBe(0);
        }
    });
});

describe("shufflePageSlots", () => {
    it("never repeats a row across pages", () => {
        // The failure the old OFFSET shuffle had -- and the one an over-fetching version of
        // this reintroduced, by filling each page from indices the next page also began at.
        const maxRowid = 1_000;
        const params = shuffleParams(11, maxRowid);
        const seen = new Set<number>();
        let total = 0;

        for (let page = 0; page < 20; page += 1) {
            for (const slot of shufflePageSlots(page, 25, maxRowid, params)) {
                seen.add(slot);
                total += 1;
            }
        }

        expect(seen.size).toBe(total);
    });

    it("never repeats, across many seeds and the whole permutation", () => {
        // Exhaustive over every page of a small library, for a range of seeds: the two
        // properties that matter are that nothing repeats and nothing is missed, and both
        // are cheap to check completely at this size.
        for (let seed = 0; seed < 25; seed += 1) {
            const maxRowid = 300;
            const params = shuffleParams(seed, maxRowid);
            const seen = new Set<number>();
            let total = 0;

            for (let page = 0; !shuffleExhausted(page, 16, params); page += 1) {
                for (const slot of shufflePageSlots(page, 16, maxRowid, params)) {
                    seen.add(slot);
                    total += 1;
                }
            }

            expect({ seed, repeated: total - seen.size, missing: maxRowid - seen.size }).toEqual({
                seed,
                repeated: 0,
                missing: 0,
            });
        }
    });

    it("stays inside the real rowid range", () => {
        // The prime overshoots the library, so some slots address nothing. They must be
        // filtered rather than handed to a lookup that silently returns fewer rows.
        const maxRowid = 37;

        for (const slot of shufflePageSlots(0, 50, maxRowid, shuffleParams(5, maxRowid))) {
            expect(slot).toBeGreaterThanOrEqual(1);
            expect(slot).toBeLessThanOrEqual(maxRowid);
        }
    });

    it("returns at most a page, and may return fewer", () => {
        // Short pages are the accepted cost of non-overlapping windows: the prime overshoots
        // the highest rowid, and deleted rows leave holes. A page of 57 beats a page that
        // silently repeats a row from the last one.
        const maxRowid = 1_000;
        const slots = shufflePageSlots(0, 20, maxRowid, shuffleParams(1, maxRowid));

        expect(slots.length).toBeLessThanOrEqual(20);
        expect(slots.length).toBeGreaterThan(0);
    });

    it("stops at the end of the permutation rather than wrapping", () => {
        // Wrapping would re-show the start of the shuffle as though it were new material.
        const maxRowid = 20;
        const params = shuffleParams(1, maxRowid);
        const slots = shufflePageSlots(100, 10, maxRowid, params);

        expect(slots).toEqual([]);
    });

    it("covers the whole library when every page is walked", () => {
        const maxRowid = 200;
        const params = shuffleParams(13, maxRowid);
        const seen = new Set<number>();

        for (let page = 0; !shuffleExhausted(page, 10, params); page += 1) {
            for (const slot of shufflePageSlots(page, 10, maxRowid, params)) {
                seen.add(slot);
            }
        }

        // Every single one: non-overlapping windows over a permutation visit the whole slot
        // space, so nothing in the library can hide from the shuffle.
        expect(seen.size).toBe(maxRowid);
    });
});

describe("shuffleExhausted", () => {
    it("is false at the start and true past the end", () => {
        const params = shuffleParams(1, 100);

        expect(shuffleExhausted(0, 10, params)).toBe(false);
        expect(shuffleExhausted(1_000, 10, params)).toBe(true);
    });

    it("does not rely on a short page to detect the end", () => {
        // Slots are skipped, so a short page happens in the middle of the shuffle too.
        // Treating short as final would truncate the library at a random point.
        const params = shuffleParams(1, 100);

        expect(shuffleExhausted(2, 10, params)).toBe(false);
    });
});
