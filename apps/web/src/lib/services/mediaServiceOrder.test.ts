import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaQuerySchema, type MediaQuery } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * How the library's three list reads choose a path (§14b, §20): the untagged override applied
 * on the server whatever the address says, and a kept order behind the shuffles and the walked
 * untagged lists, with the grid, the viewer's ids and the count all answered from the same one.
 */

const calls: { fn: string; query: MediaQuery }[] = [];
let walks = 0;

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => Object.assign(fn, { deferred: fn }) },
    mediaRepo: {
        listMedia: (query: MediaQuery) => {
            calls.push({ fn: "listMedia", query });

            return { rows: [], page: query.page, pageSize: query.limit, hasMore: false };
        },
        listMediaIdsPage: (query: MediaQuery) => {
            calls.push({ fn: "listMediaIdsPage", query });

            return { ids: [], page: query.page, pageSize: query.limit, hasMore: false };
        },
        countMedia: (query: MediaQuery) => {
            calls.push({ fn: "countMedia", query });

            return 0;
        },
        newestRowid: () => 1,
        orderedRowids: (query: MediaQuery) => {
            walks += 1;
            calls.push({ fn: "orderedRowids", query });

            return [5, 4, 3, 2, 1];
        },
        stillMatching: (_query: MediaQuery, _user: string, _roots: string[], rowids: number[]) =>
            rowids.map((rowid) => ({ rowid, id: `m${rowid}` })),
        listByIds: (ids: string[]) => ids.map((id) => ({ id, kind: "video", relPath: "a.mp4" })),
    },
    tagRepo: { listForMediaIds: () => [] },
}));

const { countMedia, listMedia, listMediaIdsPage } = await import("./mediaService");
const { forgetKeptOrders } = await import("./keptOrders");

const auth: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: [],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const untagged = [
    { match: "any", facet: "performer", rules: [{ t: "untagged", kind: "performer" }] },
];

beforeEach(() => {
    calls.length = 0;
    walks = 0;
    forgetKeptOrders();
});

describe("the untagged override, on the server", () => {
    it("runs a crafted shuffle of an untagged list by date added", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "3", groups: untagged });

        listMediaIdsPage(query, auth);

        expect(calls[0].fn).toBe("listMediaIdsPage");
        expect(calls[0].query).toMatchObject({ sort: "addedAt", direction: "desc" });
    });
});

describe("a kept order behind the walked lists", () => {
    it("serves a shuffle's grid page, ids page and count from one walk", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "3", limit: "2" });

        expect(listMediaIdsPage(query, auth, undefined, true)).toEqual({
            ids: ["m5", "m4"],
            page: 0,
            pageSize: 2,
            hasMore: true,
        });
        expect(
            listMedia({ ...query, page: 1 }, auth, undefined, true).items.map((i) => i.id)
        ).toEqual(["m3", "m2"]);
        expect(countMedia(query, auth, undefined, true)).toEqual({ total: 5, pageCount: 3 });
        expect(walks).toBe(1);
        expect(calls.map((call) => call.fn)).toEqual(["orderedRowids"]);
    });

    it("keeps a walked untagged list's order, in date order", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "3", groups: untagged });

        listMediaIdsPage(query, auth, undefined, true);
        countMedia(query, auth, undefined, true);

        expect(calls.map((call) => call.fn)).toEqual(["orderedRowids"]);
        expect(calls[0].query).toMatchObject({ sort: "addedAt", direction: "desc" });
    });

    it("reads a one-off untagged page from the index, not a whole order", () => {
        const query = mediaQuerySchema.parse({ sort: "addedAt", groups: untagged });

        listMedia(query, auth);

        expect(calls.map((call) => call.fn)).toEqual(["listMedia"]);
    });
});
