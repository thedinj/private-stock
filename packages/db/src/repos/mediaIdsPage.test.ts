import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaQuerySchema, mediaSortSchema } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * The viewer's walk through a set as ids alone (§14b, §20).
 *
 * `listMediaIdsPage` exists to answer exactly what `listMedia` answers without hydrating the
 * tiles, and the viewer relies on that: its next and previous are positions in the order, and
 * a page that disagreed with the grid's by one item would step onto the wrong one with nothing
 * to show it had. So the guarantee is tested the only way that catches it -- every sort, both
 * directions, a shuffle, a filter, ties, and pages walked to the end, compared id for id.
 */

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaRepo = await import("./mediaRepo.js");
const userMediaRepo = await import("./userMediaRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const USER = "99999999-0000-4000-8000-000000000000";

const id = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

/**
 * One item with its backing file. Values repeat every few items on purpose, so every sort has
 * ties and the order between them is decided by the id tiebreak both queries must share.
 */
const addItem = (n: number): string => {
    const db = sharedDb as Database.Database;
    const mediaId = id(n);
    const fileId = `f${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "durationMs", "width", "height", "bitrate",
                              "fps", "addedAt", "capturedAt", "probedAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
        mediaId,
        n % 3 === 0 ? "image" : "video",
        `Item ${n % 7}`,
        (n % 5) * 1000,
        640 + (n % 4) * 640,
        480 + (n % 4) * 360,
        n % 6 === 0 ? null : (n % 6) * 1000,
        n % 2 === 0 ? 30 : 24,
        `2026-01-${String((n % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
        n % 4 === 0 ? null : `2025-06-${String((n % 8) + 1).padStart(2, "0")}T00:00:00.000Z`
    );

    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(fileId, ROOT, `item-${n}.mp4`, (n % 3) * 100);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`, mediaId, fileId);

    return mediaId;
};

beforeEach(() => {
    const db = sharedDb as Database.Database;

    db.pragma("foreign_keys = OFF");

    const virtualPrefixes = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "sql" LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

    const tables = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)));

    for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES (?, 'videos', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run(ROOT);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'user@example.test', 'User', 'x', CURRENT_TIMESTAMP)`
    ).run(USER);

    for (let n = 1; n <= 47; n += 1) {
        const mediaId = addItem(n);

        // Ratings and views on some, so the per-user sorts have nulls and ties as well.
        if (n % 4 === 1) userMediaRepo.setRating(USER, mediaId, (n % 5) + 1);
        if (n % 5 === 2) userMediaRepo.recordView(USER, mediaId, false);
        if (n === 13) userMediaRepo.setHidden(USER, mediaId, true);
    }
});

type Query = ReturnType<typeof mediaQuerySchema.parse>;

/** Both answers for every page of a query, walked until either says there is no more. */
const walkBoth = (query: Query): { ids: string[][]; listed: string[][] } => {
    const ids: string[][] = [];
    const listed: string[][] = [];

    for (let page = 0; page < 30; page += 1) {
        const lean = mediaRepo.listMediaIdsPage({ ...query, page }, USER, [ROOT]);
        const full = mediaRepo.listMedia({ ...query, page }, USER, [ROOT]);

        expect(lean.hasMore).toBe(full.hasMore);
        expect(lean.page).toBe(full.page);
        expect(lean.pageSize).toBe(full.pageSize);

        ids.push(lean.ids);
        listed.push(full.rows.map((row) => row.id));

        if (!full.hasMore) return { ids, listed };
    }

    throw new Error("Paging did not terminate");
};

const sorts = mediaSortSchema.options.filter((sort) => sort !== "relevance");

describe("listMediaIdsPage", () => {
    it.each(sorts.flatMap((sort) => [`${sort} asc`, `${sort} desc`]))(
        "pages the same ids in the same order as the listing: %s",
        (spec) => {
            const [sort, direction] = spec.split(" ");
            const query = mediaQuerySchema.parse({ sort, direction, limit: "10", seed: "17" });
            const { ids, listed } = walkBoth(query);

            expect(ids).toEqual(listed);
            // The whole set, every item once: a page that matched by accident is not proof.
            expect(new Set(ids.flat()).size).toBe(46);
        }
    );

    it("follows a shuffle's seed, and another seed is another order", () => {
        const shuffle = (seed: string) =>
            walkBoth(mediaQuerySchema.parse({ sort: "random", seed, limit: "8" }));

        const first = shuffle("3");

        expect(first.ids).toEqual(first.listed);
        expect(shuffle("3").ids).toEqual(first.ids);
        expect(shuffle("4").ids.flat()).not.toEqual(first.ids.flat());
    });

    it("applies the filter the listing applies", () => {
        const query = mediaQuerySchema.parse({ kind: "video", sort: "title", limit: "7" });
        const { ids, listed } = walkBoth(query);

        expect(ids).toEqual(listed);
        expect(ids.flat().length).toBeGreaterThan(0);
    });

    it("answers past the end with nothing and no more", () => {
        const query = mediaQuerySchema.parse({ limit: "10", page: "40" });

        expect(mediaRepo.listMediaIdsPage(query, USER, [ROOT])).toEqual({
            ids: [],
            page: 40,
            pageSize: 10,
            hasMore: false,
        });
    });
});

/**
 * A kept order (§20 "A shuffle is sorted once"): the whole order once, then a slice at a time
 * with membership checked again. The web process serves the grid, its count and the viewer from
 * it, so it must agree with the pages it replaces -- same seed, same items, same order -- and
 * must stop showing an item the moment it leaves the set without moving anything else.
 */
describe("orderedRowids and stillMatching", () => {
    const PERFORMER = "77777777-0000-4000-8000-000000000000";

    const tag = (mediaId: string): void => {
        const db = sharedDb as Database.Database;

        db.prepare(
            `INSERT OR IGNORE INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
             VALUES (?, 'performer', 'Someone', 'someone', CURRENT_TIMESTAMP)`
        ).run(PERFORMER);
        db.prepare(`INSERT INTO "MediaTag" ("id", "mediaId", "tagId") VALUES (?, ?, ?)`).run(
            `mt-${mediaId}`,
            mediaId,
            PERFORMER
        );
    };

    const untagged = [
        { match: "any", facet: "performer", rules: [{ t: "untagged", kind: "performer" }] },
    ];

    /** The ids a kept order serves for every page, by slicing and re-checking. */
    const keptPages = (query: Query, rowids: number[]): string[][] => {
        const pages: string[][] = [];

        for (let start = 0; start < rowids.length; start += query.limit) {
            pages.push(
                mediaRepo
                    .stillMatching(query, USER, [ROOT], rowids.slice(start, start + query.limit))
                    .map((row) => row.id)
            );
        }

        return pages;
    };

    it.each([
        ["a shuffle", { sort: "random", seed: "17" }],
        ["a shuffle of videos", { sort: "random", seed: "5", kind: "video" }],
        ["a rated shuffle", { sort: "random", seed: "9", minRating: "2" }],
        ["untagged, newest first", { sort: "addedAt", direction: "desc", groups: untagged }],
    ])("serves the pages and count the uncached path does: %s", (_name, params) => {
        tag(id(4));
        tag(id(8));

        const query = mediaQuerySchema.parse({ ...params, limit: "10" });
        const rowids = mediaRepo.orderedRowids(query, USER, [ROOT], 1000);
        const { ids } = walkBoth(query);

        expect(keptPages(query, rowids)).toEqual(ids.filter((page) => page.length > 0));
        expect(rowids).toHaveLength(mediaRepo.countMedia(query, USER, [ROOT]));
    });

    it("drops an item tagged out of an untagged list and moves nothing else", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "11", groups: untagged });
        const rowids = mediaRepo.orderedRowids(query, USER, [ROOT], 1000);
        const before = mediaRepo.stillMatching(query, USER, [ROOT], rowids).map((row) => row.id);
        const leaving = before[3];

        tag(leaving);

        const after = mediaRepo.stillMatching(query, USER, [ROOT], rowids).map((row) => row.id);

        expect(after).toEqual(before.filter((mediaId) => mediaId !== leaving));
    });

    it("re-applies hidden and listable, not only the filter", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "2" });
        const rowids = mediaRepo.orderedRowids(query, USER, [ROOT], 1000);
        const first = mediaRepo.stillMatching(query, USER, [ROOT], rowids)[0];

        userMediaRepo.setHidden(USER, first.id, true);

        expect(
            mediaRepo.stillMatching(query, USER, [ROOT], rowids).map((row) => row.id)
        ).not.toContain(first.id);
        expect(mediaRepo.stillMatching(query, USER, [], rowids)).toEqual([]);
    });

    it("checks a look's ids the same way, in the order given (§5e)", () => {
        tag(id(4));

        const query = mediaQuerySchema.parse({ lookText: "neon", groups: untagged });
        const asked = [id(5), id(4), "no-such-item", id(1)];
        const allowed = mediaRepo.matchingIds(query, USER, [ROOT], asked);

        // id(4) is tagged out of the set and the stranger was never in it; the rest keep the
        // order they were ranked in, with the rowids a kept order is made of.
        expect(allowed.map((row) => row.id)).toEqual([id(5), id(1)]);
        expect(allowed.map((row) => row.rowid)).toEqual(
            mediaRepo.matchingIds(query, USER, [ROOT], [id(5), id(1)]).map((row) => row.rowid)
        );
        expect(mediaRepo.stillMatching(query, USER, [ROOT], [allowed[0].rowid])).toEqual([
            allowed[0],
        ]);
    });

    it("stops one past the cap, so a caller can refuse a set too long to keep", () => {
        const query = mediaQuerySchema.parse({ sort: "random", seed: "1" });

        expect(mediaRepo.orderedRowids(query, USER, [ROOT], 5)).toHaveLength(6);
    });

    it("sees an arrival in the newest rowid", () => {
        const before = mediaRepo.newestRowid();

        addItem(99);

        expect(mediaRepo.newestRowid()).toBeGreaterThan(before);
    });
});
