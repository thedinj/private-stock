import { describe, expect, it } from "vitest";

import {
    compareKeys,
    entryOrder,
    mediaWindowStart,
    mergeWindow,
    shuffleKey,
    type Keyed,
    type SortKey,
} from "./libraryMerge.js";

/**
 * The All merge (§20 "All, merged").
 *
 * The claim that fails silently if wrong: paging the merged list never repeats or drops an entry,
 * at any page size, in either direction, with ties, NULLs and mixed key types -- so the pages
 * laid end to end are exactly a plain sort of everything.
 */

/** A small deterministic generator, so a failure names a seed that reproduces it. */
const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

    return seed / 2_147_483_648;
};

const keyFrom = (next: () => number, kind: "number" | "text" | "mixed"): SortKey => {
    const roll = next();

    if (roll < 0.1) return null;
    if (kind === "number" || (kind === "mixed" && roll < 0.55)) return Math.floor(next() * 8);

    return ["apple", "Apple", "banana", "Cherry", "cherry", "date"][Math.floor(next() * 6)];
};

const pagesOf = (
    media: Keyed[],
    small: Keyed[],
    pageSize: number,
    order: (a: Keyed, b: Keyed) => number
): string[] => {
    const total = media.length + small.length;
    const out: string[] = [];

    for (let offset = 0; offset < total; offset += pageSize) {
        const start = mediaWindowStart(offset, small.length);
        const window = media.slice(start, offset + pageSize + 1);

        out.push(
            ...mergeWindow(window, start, small, offset, pageSize, order).map((entry) =>
                entry.from === "media" ? entry.id : entry.row.id
            )
        );
    }

    return out;
};

describe("merging the small set into the library's walk", () => {
    for (const kind of ["number", "text", "mixed"] as const) {
        for (const direction of ["asc", "desc"] as const) {
            for (const nocase of [false, true]) {
                it(`pages exactly a plain sort (${kind}, ${direction}${nocase ? ", nocase" : ""})`, () => {
                    for (let seed = 1; seed <= 40; seed += 1) {
                        const next = random(seed);
                        const order = entryOrder(direction, nocase);
                        const media = Array.from({ length: Math.floor(next() * 120) }, (_, i) => ({
                            id: `m${String(i).padStart(3, "0")}`,
                            k: keyFrom(next, kind),
                        })).sort(order);
                        const small = Array.from({ length: Math.floor(next() * 40) }, (_, i) => ({
                            id: `s${String(i).padStart(3, "0")}`,
                            k: keyFrom(next, kind),
                        })).sort(order);
                        const expected = [...media, ...small].sort(order).map((row) => row.id);

                        for (const pageSize of [1, 7, 60]) {
                            expect(pagesOf(media, small, pageSize, order), `seed ${seed}`).toEqual(
                                expected
                            );
                        }
                    }
                });
            }
        }
    }

    it("is empty past the end", () => {
        const order = entryOrder("asc", false);

        expect(mergeWindow([], 50, [{ id: "s", k: 1 }], 51, 10, order)).toEqual([]);
    });
});

describe("keys as SQLite compares them", () => {
    it("puts NULL before numbers before text", () => {
        expect(compareKeys(null, 0, false)).toBeLessThan(0);
        expect(compareKeys(99, "0", false)).toBeLessThan(0);
    });

    it("folds only ASCII under NOCASE", () => {
        expect(compareKeys("Apple", "apple", true)).toBe(0);
        expect(compareKeys("Apple", "apple", false)).not.toBe(0);
        expect(compareKeys("É", "é", true)).not.toBe(0);
    });
});

describe("a clip's place in a shuffle", () => {
    it("is stable for a seed and moves with it", () => {
        expect(shuffleKey("clip-1", 7)).toBe(shuffleKey("clip-1", 7));
        expect(shuffleKey("clip-1", 7)).not.toBe(shuffleKey("clip-1", 8));
    });
});
