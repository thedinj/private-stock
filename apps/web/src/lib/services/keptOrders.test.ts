import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaQuerySchema, type MediaQuery } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * A list's whole order, kept and served a slice at a time (§20 "A shuffle is sorted once").
 *
 * The repo half -- that a kept order's slices are the uncached pages -- is tested against a real
 * database in `mediaIdsPage.test.ts`. What is tested here is the keeping: when an order is taken
 * and taken again, what a slice that lost an item says, what the count says, and the bound.
 */

/** The matching set, as rowids in order, and the rowids that have since left it. */
let matching: number[] = [];
let gone = new Set<number>();
let newest = 100;
let walks = 0;

vi.mock("@private-stock/db", () => ({
    mediaRepo: {
        newestRowid: () => newest,
        orderedRowids: (_query: MediaQuery, _user: string, _roots: string[], cap: number) => {
            walks += 1;

            return matching.slice(0, cap + 1);
        },
        stillMatching: (_q: MediaQuery, _u: string, roots: string[], rowids: number[]) =>
            rowids
                .filter((rowid) => roots.length > 0 && !gone.has(rowid))
                .map((rowid) => ({ rowid, id: `m${rowid}` })),
    },
}));

const {
    countOfOrder,
    forgetKeptOrders,
    keepsOrder,
    keptOrder,
    ORDER_SLOTS,
    ORDER_TTL_MS,
    pageOfOrder,
} = await import("./keptOrders");

const auth = (userId = "u1", accessibleRootIds = ["r1"]): AuthContext => ({
    userId,
    email: `${userId}@example.test`,
    displayName: userId,
    scopes: [],
    accessibleRootIds,
    tokenEpoch: 0,
});

const shuffle = (over: Record<string, string> = {}): MediaQuery =>
    mediaQuerySchema.parse({ sort: "random", seed: "7", limit: "10", ...over });

const untagged = [
    { match: "any", facet: "performer", rules: [{ t: "untagged", kind: "performer" }] },
];

const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeEach(() => {
    forgetKeptOrders();
    matching = range(1, 25);
    gone = new Set();
    newest = 100;
    walks = 0;
});

describe("keepsOrder", () => {
    it("keeps a shuffle's order for every caller", () => {
        expect(keepsOrder(shuffle(), false)).toBe(true);
        expect(keepsOrder(shuffle(), true)).toBe(true);
    });

    it("keeps an untagged list's order only for a caller walking it", () => {
        const query = mediaQuerySchema.parse({ sort: "addedAt", groups: untagged });

        expect(keepsOrder(query, true)).toBe(true);
        expect(keepsOrder(query, false)).toBe(false);
    });

    it("leaves every other list to its index", () => {
        expect(keepsOrder(mediaQuerySchema.parse({ sort: "size", favorite: "true" }), true)).toBe(
            false
        );
    });
});

describe("keptOrder", () => {
    it("walks once and serves every page, page size and count from that walk", () => {
        const order = keptOrder(shuffle(), auth(), undefined, 0)!;

        expect(pageOfOrder(order, shuffle({ page: "1" }), auth()).ids).toEqual(
            range(11, 20).map((n) => `m${n}`)
        );
        expect(keptOrder(shuffle({ page: "2", limit: "200" }), auth(), undefined, 1)).toBe(order);
        expect(countOfOrder(order, 10)).toEqual({ total: 25, pageCount: 3 });
        expect(walks).toBe(1);
    });

    it("keeps one order per seed, viewer, libraries and overlay", () => {
        keptOrder(shuffle(), auth(), undefined, 0);
        keptOrder(shuffle({ seed: "8" }), auth(), undefined, 0);
        keptOrder(shuffle(), auth("u2"), undefined, 0);
        keptOrder(shuffle(), auth("u1", ["r1", "r2"]), undefined, 0);
        keptOrder(shuffle(), auth(), "owner", 0);
        keptOrder(shuffle(), auth(), undefined, 0);

        expect(walks).toBe(5);
    });

    it("walks again when something has arrived since", () => {
        keptOrder(shuffle(), auth(), undefined, 0);
        newest = 101;
        matching = range(1, 26);

        expect(keptOrder(shuffle(), auth(), undefined, 1)!.rowids).toHaveLength(26);
        expect(walks).toBe(2);
    });

    it("walks again once the order expires", () => {
        keptOrder(shuffle(), auth(), undefined, 0);
        keptOrder(shuffle(), auth(), undefined, ORDER_TTL_MS - 1);
        keptOrder(shuffle(), auth(), undefined, ORDER_TTL_MS);

        expect(walks).toBe(2);
    });

    it("walks again after the library caches are cleared", () => {
        keptOrder(shuffle(), auth(), undefined, 0);
        forgetKeptOrders();
        keptOrder(shuffle(), auth(), undefined, 1);

        expect(walks).toBe(2);
    });

    it("refuses a set larger than the whole budget, and remembers refusing", () => {
        matching = range(1, ORDER_SLOTS + 1);

        expect(keptOrder(shuffle(), auth(), undefined, 0)).toBeNull();
        expect(keptOrder(shuffle(), auth(), undefined, 1)).toBeNull();
        expect(walks).toBe(1);
    });

    it("holds no more slots than the budget across orders, dropping the oldest", () => {
        matching = range(1, ORDER_SLOTS / 2 + 1);

        keptOrder(shuffle({ seed: "1" }), auth(), undefined, 0);
        keptOrder(shuffle({ seed: "2" }), auth(), undefined, 1);
        // Two halves and two slots over: the first went to make room.
        keptOrder(shuffle({ seed: "2" }), auth(), undefined, 2);
        keptOrder(shuffle({ seed: "1" }), auth(), undefined, 3);

        expect(walks).toBe(3);
    });
});

describe("pageOfOrder and countOfOrder", () => {
    it("drops an item that left, keeps every other slot, and counts it out", () => {
        const order = keptOrder(shuffle(), auth(), undefined, 0)!;

        gone.add(3);

        const first = pageOfOrder(order, shuffle(), auth());

        expect(first.ids).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10].map((n) => `m${n}`));
        expect(first.hasMore).toBe(true);
        // The next page starts where it always did: nothing slid onto this one.
        expect(pageOfOrder(order, shuffle({ page: "1" }), auth()).ids[0]).toBe("m11");
        expect(countOfOrder(order, 10)).toEqual({ total: 24, pageCount: 3 });
    });

    it("counts an item back in when a later check finds it again", () => {
        const order = keptOrder(shuffle(), auth(), undefined, 0)!;

        gone.add(3);
        pageOfOrder(order, shuffle(), auth());
        gone.clear();
        pageOfOrder(order, shuffle(), auth());

        expect(countOfOrder(order, 10).total).toBe(25);
    });

    it("says whether any slot lies past the page, however short the page came back", () => {
        const order = keptOrder(shuffle(), auth(), undefined, 0)!;

        for (const rowid of range(21, 25)) gone.add(rowid);

        expect(pageOfOrder(order, shuffle({ page: "1" }), auth()).hasMore).toBe(true);
        expect(pageOfOrder(order, shuffle({ page: "2" }), auth())).toEqual({
            ids: [],
            hasMore: false,
        });
        expect(pageOfOrder(order, shuffle({ page: "9" }), auth())).toEqual({
            ids: [],
            hasMore: false,
        });
    });
});
