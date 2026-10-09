import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    EMBED_DIMS,
    REPRESENTATIVES_LOG_REL_PATH,
    encodeRepresentatives,
    encodeVectorFile,
    mediaQuerySchema,
    normaliseVector,
    quantize,
    vectorFileRelPath,
    type MediaQuery,
    type VectorFile,
} from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Ordering the library by a look (§5e "Search runs in two passes"): ranked by representatives, the best read in
 * full and reordered, narrowed by the rest of the query, and served as a kept order with each
 * item's matching moment beside it.
 *
 * Real vectors files and a real log in a temporary data directory; the database and the text
 * model are stood in for, the one by a filter over ids and the other by a fixed direction.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "ps-look-"));

/** Ids the stand-in database refuses, as if the rest of the query left them out. */
const refused = new Set<string>();
const rowidOf = (id: string): number => Number(id.replace(/\D/g, "")) || id.length;

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => Object.assign(fn, { deferred: fn }) },
    mediaRepo: {
        newestRowid: () => 1,
        matchingIds: (_query: MediaQuery, _user: string, _roots: string[], ids: string[]) =>
            ids
                .filter((id) => !refused.has(id))
                .map((id) => ({ rowid: rowidOf(id), id, kind: id === "m4" ? "image" : "video" })),
        stillMatching: (_query: MediaQuery, _user: string, _roots: string[], rowids: number[]) =>
            rowids.map((rowid) => ({ rowid, id: `m${rowid}` })),
        listByIds: (ids: string[]) =>
            ids
                .filter((id) => !refused.has(id))
                .map((id) => ({ id, kind: "video", relPath: "a.mp4" })),
    },
    tagRepo: { listForMediaIds: () => [] },
    // No sprite sheets: each moment comes back without a picture, and the tile keeps its cover.
    artifactRepo: { listForMedia: () => [] },
}));

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
    // Words always mean the first axis: "the look" every test asks for.
    encodeLookText: async () => direction(0),
}));

const { listMedia, countMedia } = await import("./mediaService");
const { forgetKeptOrders } = await import("./keptOrders");
const { prepareLook } = await import("./lookService");

const auth: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: [],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

/** A unit vector along one axis, leaning `lean` of the way towards another. */
function direction(axis: number, lean = 0, towards = axis + 1): Float32Array {
    const vector = new Float32Array(EMBED_DIMS);

    vector[axis] = 1 - lean;
    vector[towards] += lean;

    return normaliseVector(vector);
}

const moment = (atMs: number | null, vector: Float32Array) => ({
    atMs,
    square: 0,
    vector: quantize(vector),
});

/** Write an item's vectors file and append its representatives to the log, as the worker does. */
const embed = (mediaId: string, vectors: VectorFile["vectors"], representatives: number[]) => {
    const file: VectorFile = {
        model: "clip-b32-vision-uint8",
        stageVersion: 1,
        dims: EMBED_DIMS,
        vectors,
        representatives,
    };
    const vecPath = path.join(dataDir, vectorFileRelPath(mediaId));

    mkdirSync(path.dirname(vecPath), { recursive: true });
    writeFileSync(vecPath, encodeVectorFile(file));
    appendFileSync(
        path.join(dataDir, REPRESENTATIVES_LOG_REL_PATH),
        encodeRepresentatives(mediaId, file)
    );
};

mkdirSync(path.join(dataDir, "embed"), { recursive: true });

// m1: one representative, close to the look, at 4 s.
embed("m1", [moment(4000, direction(0, 0.3))], [0]);
// m2: looks nothing like it anywhere.
embed("m2", [moment(1000, direction(5))], [0]);
// m3: its representative looks nothing like it, but a moment that was not chosen as one is
// exactly it -- only the second pass can find that.
embed("m3", [moment(0, direction(7)), moment(9000, direction(0))], [0]);
// m4: a photograph, close to the look as a whole.
embed("m4", [moment(null, direction(0, 0.5))], [0]);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
    refused.clear();
    forgetKeptOrders();
});

const lookQuery = (params: Record<string, string>): MediaQuery =>
    mediaQuerySchema.parse({ limit: "2", ...params });

const listed = async (params: Record<string, string>) => {
    const query = lookQuery(params);

    await prepareLook(query, auth);

    return listMedia(query, auth, undefined, true);
};

describe("a look in words", () => {
    it("lists the best matches first, after reading the best in full", async () => {
        const first = await listed({ lookText: "the look" });
        const second = await listed({ lookText: "the look", page: "1" });

        // m3's own representative scored nothing; its full read found the best moment of all.
        expect([...first.items, ...second.items].map((item) => item.id)).toEqual([
            "m3",
            "m1",
            "m4",
            "m2",
        ]);
        expect(first.hasMore).toBe(true);
    });

    it("says where each item matched, and nothing for a photograph", async () => {
        const first = await listed({ lookText: "the look" });
        const second = await listed({ lookText: "the look", page: "1" });

        const times = (moments: typeof first.moments) =>
            Object.fromEntries(Object.entries(moments ?? {}).map(([id, m]) => [id, m.atMs]));

        expect(times(first.moments)).toEqual({ m3: 9000, m1: 4000 });
        expect(times(second.moments)).toEqual({ m2: 1000 });
        expect(first.moments?.m3).toEqual({ atMs: 9000, thumbUrl: null, thumbRect: null });
    });

    it("lists only what the rest of the query allows", async () => {
        refused.add("m3");

        const page = await listed({ lookText: "the look" });

        expect(page.items.map((item) => item.id)).toEqual(["m1", "m4"]);
    });

    it("is ordered by the look whatever sort was asked for, and counted from its list", async () => {
        const query = lookQuery({ lookText: "the look", sort: "title" });

        await prepareLook(query, auth);

        expect(listMedia(query, auth, undefined, true).items[0].id).toBe("m3");
        expect(countMedia(query, auth, undefined, true)).toEqual({ total: 4, pageCount: 2 });
    });

    it("refuses to list a look nobody prepared, rather than listing the library", () => {
        const query = lookQuery({ lookText: "never prepared" });

        expect(() => listMedia(query, auth, undefined, true)).toThrow(/not ready/);
    });
});

describe("more like this", () => {
    it("starts from the moment asked about, and leaves that item out", async () => {
        // m1 at 4 s leans towards axis 1; nearest after itself is m4, then m3's best moment.
        const page = await listed({ like: "m1@4100" });

        expect(page.items.map((item) => item.id)).not.toContain("m1");
        expect(page.items[0].id).toBe("m4");
    });

    it("will not start from an item the viewer cannot see", async () => {
        refused.add("m2");

        await expect(prepareLook(lookQuery({ like: "m2@1000" }), auth)).rejects.toThrow(
            /not found/i
        );
    });

    it("says so when the item has not been embedded", async () => {
        await expect(prepareLook(lookQuery({ like: "m9" }), auth)).rejects.toThrow(
            /not been looked at/
        );
    });
});

describe("the index", () => {
    it("picks up an item the worker has embedded since", async () => {
        embed("m5", [moment(2000, direction(0, 0.01))], [0]);

        const page = await listed({ lookText: "the look", limit: "5" });

        expect(page.items.map((item) => item.id)).toContain("m5");
    });
});

describe("one look at a time", () => {
    it("refuses words and a moment together", async () => {
        await expect(
            prepareLook(lookQuery({ lookText: "the look", like: "m1@4000" }), auth)
        ).rejects.toThrow(/not both/);
    });
});
