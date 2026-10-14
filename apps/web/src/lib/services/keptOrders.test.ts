import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaKinds, mediaQuerySchema, type MediaKind, type MediaQuery } from "@private-stock/core";

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
/** What each walk was asked for. */
let walked: MediaQuery[] = [];

/** Every third item is a photo, the rest videos. */
const kindOf = (rowid: number): MediaKind => (rowid % 3 === 0 ? "image" : "video");

/** What `orderedRowids` answers for these rowids, as a walk handed to a plan by hand. */
const walkOf = (rowids: number[]) => ({
    rowids,
    kinds: Uint8Array.from(rowids, (rowid) => mediaKinds.indexOf(kindOf(rowid))),
});

/** The repo's two walks, behind the same names the read plans ask for them by. */
const repo = {
    newestRowid: () => newest,
    orderedRowids: (query: MediaQuery, _user: string, _roots: string[], cap: number) => {
        walks += 1;
        walked.push(query);

        const rowids = matching
            .filter((rowid) => query.kind === undefined || kindOf(rowid) === query.kind)
            .slice(0, cap + 1);

        return walkOf(rowids);
    },
    stillMatching: (query: MediaQuery, _u: string, roots: string[], rowids: number[]) =>
        rowids
            .filter((rowid) => roots.length > 0 && !gone.has(rowid))
            .filter((rowid) => query.kind === undefined || kindOf(rowid) === query.kind)
            .map((rowid) => ({ rowid, id: `m${rowid}` })),
};

vi.mock("@private-stock/db", async () => {
    const { readPlanMock } = await import("./readPlanMock");

    return { mediaRepo: repo, ...(await readPlanMock({ mediaRepo: repo })) };
});

const {
    countOfOrder,
    forgetKeptOrders,
    keepsOrder,
    keptOrder,
    ORDER_SLOTS,
    ORDER_TTL_MS,
    pageOfOrder,
} = await import("./keptOrders");
const { runNow } = await import("@private-stock/db");

/** The plans, run as the synchronous callers run them. */
const kept = (...args: Parameters<typeof keptOrder>) => runNow(keptOrder(...args));
const page = (...args: Parameters<typeof pageOfOrder>) => runNow(pageOfOrder(...args));

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
    walked = [];
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
    it("does not keep an order that a forget overtook while it was being walked", () => {
        // Off the thread, the walk is an `await`: a library can be disabled while it runs, and
        // the order it returns describes the library before that.
        const plan = keptOrder(shuffle(), auth(), undefined, 0);

        plan.next();
        forgetKeptOrders();

        const step = plan.next(walkOf(range(1, 25)));

        // Served to the request that took it...
        expect(step.done && step.value?.rowids).toHaveLength(25);
        // ...and taken again by the next one, rather than kept past the forget.
        kept(shuffle(), auth(), undefined, 1);
        expect(walks).toBe(1);
    });

    it("walks once and serves every page, page size and count from that walk", () => {
        const order = kept(shuffle(), auth(), undefined, 0)!;

        expect(page(order, shuffle({ page: "1" }), auth()).ids).toEqual(
            range(11, 20).map((n) => `m${n}`)
        );
        expect(kept(shuffle({ page: "2", limit: "200" }), auth(), undefined, 1)).toBe(order);
        expect(countOfOrder(order, shuffle())).toEqual({ total: 25, pageCount: 3 });
        expect(walks).toBe(1);
    });

    it("keeps one order per seed, viewer, libraries and overlay", () => {
        kept(shuffle(), auth(), undefined, 0);
        kept(shuffle({ seed: "8" }), auth(), undefined, 0);
        kept(shuffle(), auth("u2"), undefined, 0);
        kept(shuffle(), auth("u1", ["r1", "r2"]), undefined, 0);
        kept(shuffle(), auth(), "owner", 0);
        kept(shuffle(), auth(), undefined, 0);

        expect(walks).toBe(5);
    });

    it("walks again when something has arrived since", () => {
        kept(shuffle(), auth(), undefined, 0);
        newest = 101;
        matching = range(1, 26);

        expect(kept(shuffle(), auth(), undefined, 1)!.rowids).toHaveLength(26);
        expect(walks).toBe(2);
    });

    it("walks again once the order expires", () => {
        kept(shuffle(), auth(), undefined, 0);
        kept(shuffle(), auth(), undefined, ORDER_TTL_MS - 1);
        kept(shuffle(), auth(), undefined, ORDER_TTL_MS);

        expect(walks).toBe(2);
    });

    it("walks again after the library caches are cleared", () => {
        kept(shuffle(), auth(), undefined, 0);
        forgetKeptOrders();
        kept(shuffle(), auth(), undefined, 1);

        expect(walks).toBe(2);
    });

    it("refuses a set larger than the whole budget, and remembers refusing", () => {
        matching = range(1, ORDER_SLOTS + 1);

        expect(kept(shuffle(), auth(), undefined, 0)).toBeNull();
        expect(kept(shuffle(), auth(), undefined, 1)).toBeNull();
        expect(walks).toBe(1);
    });

    it("holds no more slots than the budget across orders, dropping the oldest", () => {
        matching = range(1, ORDER_SLOTS / 2 + 1);

        kept(shuffle({ seed: "1" }), auth(), undefined, 0);
        kept(shuffle({ seed: "2" }), auth(), undefined, 1);
        // Two halves and two slots over: the first went to make room.
        kept(shuffle({ seed: "2" }), auth(), undefined, 2);
        kept(shuffle({ seed: "1" }), auth(), undefined, 3);

        expect(walks).toBe(3);
    });
});

describe("pageOfOrder and countOfOrder", () => {
    it("drops an item that left, keeps every other slot, and counts it out", () => {
        const order = kept(shuffle(), auth(), undefined, 0)!;

        gone.add(3);

        const first = page(order, shuffle(), auth());

        expect(first.ids).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10].map((n) => `m${n}`));
        expect(first.hasMore).toBe(true);
        // The next page starts where it always did: nothing slid onto this one.
        expect(page(order, shuffle({ page: "1" }), auth()).ids[0]).toBe("m11");
        expect(countOfOrder(order, shuffle())).toEqual({ total: 24, pageCount: 3 });
    });

    it("counts an item back in when a later check finds it again", () => {
        const order = kept(shuffle(), auth(), undefined, 0)!;

        gone.add(3);
        page(order, shuffle(), auth());
        gone.clear();
        page(order, shuffle(), auth());

        expect(countOfOrder(order, shuffle()).total).toBe(25);
    });

    it("says whether any slot lies past the page, however short the page came back", () => {
        const order = kept(shuffle(), auth(), undefined, 0)!;

        for (const rowid of range(21, 25)) gone.add(rowid);

        expect(page(order, shuffle({ page: "1" }), auth()).hasMore).toBe(true);
        expect(page(order, shuffle({ page: "2" }), auth())).toEqual({
            ids: [],
            hasMore: false,
        });
        expect(page(order, shuffle({ page: "9" }), auth())).toEqual({
            ids: [],
            hasMore: false,
        });
    });
});

describe("one order for both kind tabs", () => {
    const videos = range(1, 25).filter((rowid) => kindOf(rowid) === "video");
    const photos = range(1, 25).filter((rowid) => kindOf(rowid) === "image");

    it("walks once, without the kind, for the Videos tab, the Photos tab and All", () => {
        const video = kept(shuffle({ kind: "video" }), auth(), undefined, 0)!;

        expect(kept(shuffle({ kind: "image" }), auth(), undefined, 1)).toBe(video);
        expect(kept(shuffle(), auth(), undefined, 2)).toBe(video);
        expect(walks).toBe(1);
        expect(walked[0].kind).toBeUndefined();
    });

    it("pages and counts each kind from its own slots, full pages and in order", () => {
        const order = kept(shuffle({ kind: "video" }), auth(), undefined, 0)!;
        const pageOf = (kind: MediaKind, n: number) =>
            page(order, shuffle({ kind, page: String(n) }), auth());

        expect(pageOf("video", 0).ids).toEqual(videos.slice(0, 10).map((n) => `m${n}`));
        expect(pageOf("video", 1)).toEqual({
            ids: videos.slice(10, 20).map((n) => `m${n}`),
            hasMore: false,
        });
        expect(pageOf("image", 0)).toEqual({
            ids: photos.map((n) => `m${n}`),
            hasMore: false,
        });
        expect(countOfOrder(order, shuffle({ kind: "video" }))).toEqual({
            total: videos.length,
            pageCount: 2,
        });
        expect(countOfOrder(order, shuffle({ kind: "image" }))).toEqual({
            total: photos.length,
            pageCount: 1,
        });
        expect(countOfOrder(order, shuffle())).toEqual({ total: 25, pageCount: 3 });
    });

    it("counts a departure against its own kind and against All, wherever it was seen", () => {
        const order = kept(shuffle({ kind: "video" }), auth(), undefined, 0)!;

        gone.add(photos[0]);
        // Seen leaving on the All tab's page, then counted out of the Photos tab too.
        page(order, shuffle(), auth());

        expect(countOfOrder(order, shuffle({ kind: "image" })).total).toBe(photos.length - 1);
        expect(countOfOrder(order, shuffle({ kind: "video" })).total).toBe(videos.length);
        expect(countOfOrder(order, shuffle()).total).toBe(24);
    });
});

describe("one take, however many ask", () => {
    /** A plan as `runOffThread` drives it: up to its first request, which is then answered. */
    const start = (query: MediaQuery, now = 0) => {
        const plan = keptOrder(query, auth(), undefined, now);

        return { plan, first: plan.next() };
    };

    it("lets a request for the order being taken wait for that take, not walk again", async () => {
        const list = start(shuffle({ kind: "video" }));
        const count = start(shuffle({ kind: "image" }));

        expect(count.first.done).toBe(false);
        expect(count.first.value).toHaveProperty("join");

        const taken = list.plan.next(walkOf(range(1, 25)));
        const waited = await (count.first.value as { join: Promise<unknown> }).join;

        expect(taken.done && taken.value).toBe(waited);
        expect(count.plan.next(waited)).toEqual({ done: true, value: waited });
    });

    it("takes its own when the driver cannot wait, or the take it waited on failed", async () => {
        const list = start(shuffle());
        const count = start(shuffle());

        // The walk failing, as a reader thread's death hands it into the plan.
        expect(() => list.plan.throw(new Error("the reader stopped"))).toThrow("stopped");

        await expect(
            (count.first.value as { join: Promise<unknown> }).join
        ).resolves.toBeUndefined();

        // Handed `undefined`, the plan asks for the walk itself.
        expect(count.plan.next(undefined).value).toMatchObject({ name: "orderedRowids" });
    });

    it("does not wait on a take begun before an arrival, or before a forget", () => {
        start(shuffle());
        newest = 101;

        expect(start(shuffle()).first.value).toMatchObject({ name: "orderedRowids" });

        forgetKeptOrders();

        expect(start(shuffle()).first.value).toMatchObject({ name: "orderedRowids" });
    });
});
