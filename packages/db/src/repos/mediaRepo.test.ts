import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The library query: paging, filtering, and faceting.
 *
 * The centrepiece here is keyset paging, which is the part of this query with a failure mode
 * that produces no error at all — just rows that quietly repeat. Everything else fails
 * loudly; this does not, so it is tested by walking whole result sets and asserting the
 * union rather than by checking one page looks plausible.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaRepo = await import("./mediaRepo.js");
const artifactRepo = await import("./artifactRepo.js");
const tagRepo = await import("./tagRepo.js");
const userMediaRepo = await import("./userMediaRepo.js");
const searchRepo = await import("./searchRepo.js");
const mentionRepo = await import("./mentionRepo.js");
const { buildTagMatcher, mentionsIn } = await import("@private-stock/core");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const USER = "99999999-0000-4000-8000-000000000000";
/** Somebody else, whose ratings a shared filter can be resolved against (§6). */
const OWNER = "99999999-0000-4000-8000-000000000001";

const id = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

interface ItemOptions {
    title: string;
    durationMs: number;
    size: number;
}

/** One Media with its backing file, which the library query inner-joins. */
const addItem = (n: number, options: ItemOptions): string => {
    const mediaId = id(n);
    const fileId = `f${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

    sharedDb
        .prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "durationMs", "probedAt", "updatedAt")
             VALUES (?, 'video', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .run(mediaId, options.title, options.durationMs);

    sharedDb
        .prepare(
            `INSERT INTO "MediaFile"
                 ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
             VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .run(fileId, ROOT, `${options.title}.mp4`, options.size);

    sharedDb
        .prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES (?, ?, ?, 'original')`
        )
        .run(`l${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`, mediaId, fileId);

    return mediaId;
};

/**
 * Every page, followed to the end.
 *
 * The cap is a safety net rather than a parameter: a paging bug that never reports the end
 * produces an endless sequence of pages, and without it this test hangs instead of failing.
 */
const pageThrough = (
    query: Parameters<typeof mediaRepo.listMedia>[0],
    pageSize: number
): string[] => {
    const seen: string[] = [];

    for (let page = 0; page < 20; page += 1) {
        const result = mediaRepo.listMedia({ ...query, limit: pageSize, page }, USER, [ROOT]);

        seen.push(...result.rows.map((row) => row.id));

        if (!result.hasMore) {
            return seen;
        }
    }

    throw new Error("Paging did not terminate — hasMore never became false");
};

const baseQuery = {
    sort: "addedAt",
    direction: "desc",
    limit: 100,
    page: 0,
} as unknown as Parameters<typeof mediaRepo.listMedia>[0];

beforeEach(() => {
    db = sharedDb as Database.Database;
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

    for (const [userId, email] of [
        [USER, "user@example.test"],
        [OWNER, "owner@example.test"],
    ]) {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES (?, ?, 'User', 'x', CURRENT_TIMESTAMP)`
        ).run(userId, email);
    }
});

describe("keyset paging", () => {
    /**
     * Numeric sorts are the regression this exists for.
     *
     * A cursor round-trips through a string, and SQLite compares across storage classes by
     * class before value — every integer sorts before every string. So a numeric sort
     * compared against a text-bound cursor made `value < :cursor` true for every row: the
     * keyset clause stopped filtering entirely and page two returned page one, forever.
     *
     * Nothing about that is visible in a single page, which is why these walk the whole set
     * and assert on the union.
     */
    const numericSorts = ["duration", "size", "rating"] as const;

    it.each(numericSorts)("visits every item exactly once when sorting by %s", (sort) => {
        for (let n = 1; n <= 7; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n * 1_000, size: n * 100 });
        }

        const seen = pageThrough({ ...baseQuery, sort }, 2);

        expect(new Set(seen).size).toBe(7);
        expect(seen).toHaveLength(7);
    });

    it("visits every item exactly once when sorting by a text column", () => {
        for (let n = 1; n <= 7; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n * 1_000, size: n * 100 });
        }

        const seen = pageThrough({ ...baseQuery, sort: "title", direction: "asc" }, 2);

        expect(new Set(seen).size).toBe(7);
    });

    it("orders by duration correctly rather than merely completing", () => {
        // Paging over every row would also "pass" if the sort silently fell back to id
        // order, so the ordering itself is asserted separately.
        addItem(1, { title: "Short", durationMs: 1_000, size: 10 });
        addItem(2, { title: "Long", durationMs: 100_000, size: 10 });
        addItem(3, { title: "Middle", durationMs: 50_000, size: 10 });

        const rows = mediaRepo.listMedia(
            { ...baseQuery, sort: "duration", direction: "desc" },
            USER,
            [ROOT]
        ).rows;

        expect(rows.map((row) => row.title)).toEqual(["Long", "Middle", "Short"]);
    });
});

describe("page addressing", () => {
    it("returns the requested page, not the first one", () => {
        for (let n = 1; n <= 10; n += 1) {
            addItem(n, { title: `Item ${String(n).padStart(2, "0")}`, durationMs: n, size: n });
        }

        const pageOf = (page: number) =>
            mediaRepo
                .listMedia(
                    { ...baseQuery, sort: "title", direction: "asc", limit: 3, page },
                    USER,
                    [ROOT]
                )
                .rows.map((row) => row.title);

        expect(pageOf(0)).toEqual(["Item 01", "Item 02", "Item 03"]);
        expect(pageOf(2)).toEqual(["Item 07", "Item 08", "Item 09"]);
    });

    it("reports hasMore without counting", () => {
        for (let n = 1; n <= 5; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        // Exactly one page of results: hasMore must be false even though the page came back
        // full, which is the case a naive `rows.length === limit` check gets wrong.
        expect(mediaRepo.listMedia({ ...baseQuery, limit: 5 }, USER, [ROOT]).hasMore).toBe(false);
        expect(mediaRepo.listMedia({ ...baseQuery, limit: 4 }, USER, [ROOT]).hasMore).toBe(true);
    });

    it("returns an empty page past the end rather than failing", () => {
        addItem(1, { title: "Only", durationMs: 1, size: 1 });

        const result = mediaRepo.listMedia({ ...baseQuery, limit: 10, page: 99 }, USER, [ROOT]);

        expect(result.rows).toEqual([]);
        expect(result.hasMore).toBe(false);
    });
});

describe("countMedia", () => {
    it("counts the filtered set", () => {
        for (let n = 1; n <= 7; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" IN (?, ?)`).run(id(1), id(2));

        expect(mediaRepo.countMedia(baseQuery, USER, [ROOT])).toBe(7);
        expect(mediaRepo.countMedia({ ...baseQuery, kind: "image" }, USER, [ROOT])).toBe(2);
    });

    it("does not vary with the page", () => {
        // The whole reason it is a separate call: the client caches it against the filter and
        // has to be able to trust that turning a page cannot change it.
        for (let n = 1; n <= 7; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        expect(mediaRepo.countMedia({ ...baseQuery, page: 3 }, USER, [ROOT])).toBe(
            mediaRepo.countMedia({ ...baseQuery, page: 0 }, USER, [ROOT])
        );
    });
});

describe("countVisible", () => {
    /**
     * The navigation's counts, which sit beside the grid they describe (§14).
     *
     * This is the whole reason the count is not `count(*) FROM "Media"`: an item whose only
     * file has been archived or trashed still has its row, so the nav said ten while the grid
     * showed five and nothing on the page explained the difference.
     */
    it("counts only what the viewer could open", () => {
        for (let n = 1; n <= 5; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" = ?`).run(id(1));

        expect(mediaRepo.countVisible(USER, [ROOT])).toEqual({
            total: 5,
            videos: 4,
            images: 1,
        });

        // Archiving the original file is what `listable` is derived from, so this is the
        // state the library query has always excluded and the nav used to include.
        db.prepare(
            `UPDATE "MediaFile" SET "state" = 'archived'
              WHERE "id" IN (SELECT "fileId" FROM "MediaFileLink" WHERE "mediaId" IN (?, ?))`
        ).run(id(1), id(2));

        expect(db.prepare(`SELECT count(*) AS n FROM "Media"`).get()).toEqual({ n: 5 });
        expect(mediaRepo.countVisible(USER, [ROOT])).toEqual({
            total: 3,
            videos: 3,
            images: 0,
        });
    });

    it("leaves out items this viewer has hidden", () => {
        addItem(1, { title: "Kept", durationMs: 1, size: 1 });
        const hidden = addItem(2, { title: "Put away", durationMs: 2, size: 2 });

        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
             VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
        ).run(USER, hidden);

        expect(mediaRepo.countVisible(USER, [ROOT]).total).toBe(1);
        // Hiding is the viewer's own instruction, so it must not shrink anyone else's count.
        expect(mediaRepo.countVisible(OWNER, [ROOT]).total).toBe(2);
    });

    it("counts nothing when the user has no accessible roots", () => {
        addItem(1, { title: "A Video", durationMs: 1, size: 1 });

        expect(mediaRepo.countVisible(USER, [])).toEqual({ total: 0, videos: 0, images: 0 });
    });

    it("reports zeroes rather than nulls for an empty library", () => {
        // sum() over no rows is NULL, and the nav renders the number it is given.
        expect(mediaRepo.countVisible(USER, [ROOT])).toEqual({ total: 0, videos: 0, images: 0 });
    });
});

describe("shuffle", () => {
    it("visits every item exactly once across its pages", () => {
        // The property the prime-modulus permutation exists to provide. The OFFSET shuffle it
        // replaced repeated rows across page boundaries while hiding others entirely.
        for (let n = 1; n <= 30; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        const seen: string[] = [];

        for (let page = 0; page < 60; page += 1) {
            const result = mediaRepo.listMedia(
                { ...baseQuery, sort: "random", seed: 7, limit: 8, page },
                USER,
                [ROOT]
            );

            seen.push(...result.rows.map((row) => row.id));

            if (!result.hasMore) break;
        }

        expect(new Set(seen).size).toBe(seen.length);
        expect(new Set(seen).size).toBe(30);
    });

    it("is stable for a seed and different for another", () => {
        for (let n = 1; n <= 30; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        const firstPage = (seed: number) =>
            mediaRepo
                .listMedia({ ...baseQuery, sort: "random", seed, limit: 10 }, USER, [ROOT])
                .rows.map((row) => row.id);

        expect(firstPage(1)).toEqual(firstPage(1));
        expect(firstPage(1)).not.toEqual(firstPage(2));
    });

    it("still respects the filter", () => {
        // A shuffle addresses rows by slot rather than by ordered position, so it would be
        // easy to bypass the WHERE clause and quietly shuffle the whole table.
        for (let n = 1; n <= 20; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        db.prepare(`UPDATE "Media" SET "kind" = 'image'`).run();

        expect(
            mediaRepo.listMedia(
                { ...baseQuery, sort: "random", seed: 3, kind: "video", limit: 20 },
                USER,
                [ROOT]
            ).rows
        ).toEqual([]);
    });

    it("returns nothing for a user with no roots", () => {
        addItem(1, { title: "Item", durationMs: 1, size: 1 });

        expect(
            mediaRepo.listMedia({ ...baseQuery, sort: "random", seed: 1, limit: 10 }, USER, []).rows
        ).toEqual([]);
    });
});

describe("text search", () => {
    const indexItem = (mediaId: string, title: string): void => {
        searchRepo.upsertDocument({
            mediaId,
            filename: "",
            title,
            performers: "",
            series: "",
            studio: "",
            tags: "",
            attributes: "",
            notes: "",
        });
    };

    it("returns only matching items", () => {
        const rain = addItem(1, { title: "Summer Rain", durationMs: 1, size: 1 });
        const sun = addItem(2, { title: "Winter Sun", durationMs: 1, size: 1 });

        indexItem(rain, "Summer Rain");
        indexItem(sun, "Winter Sun");

        const result = mediaRepo.listMedia({ ...baseQuery, search: "summer" }, USER, [ROOT]);

        expect(result.rows.map((row) => row.id)).toEqual([rain]);
        expect(mediaRepo.countMedia({ ...baseQuery, search: "summer" }, USER, [ROOT])).toBe(1);
    });

    it("returns nothing when the search has no searchable characters", () => {
        // Falling through to an unfiltered library here would look like the search box had
        // simply been ignored, which is worse than an empty result.
        const rain = addItem(1, { title: "Summer Rain", durationMs: 1, size: 1 });
        indexItem(rain, "Summer Rain");

        expect(mediaRepo.listMedia({ ...baseQuery, search: "!!!" }, USER, [ROOT]).rows).toEqual([]);
    });

    it("pages a relevance sort without repeating items", () => {
        for (let n = 1; n <= 5; n += 1) {
            const mediaId = addItem(n, { title: `Rain ${n}`, durationMs: n, size: n });
            indexItem(mediaId, `Rain ${n}`);
        }

        const seen = pageThrough({ ...baseQuery, search: "rain", sort: "relevance" }, 2);

        expect(new Set(seen).size).toBe(5);
    });

    it("excludes an item whose document has not been written yet", () => {
        // Newly scanned items are unindexed until the index stage runs. They must not appear
        // in search results, or search would be non-deterministic during a scan.
        addItem(1, { title: "Summer Rain", durationMs: 1, size: 1 });

        expect(mediaRepo.listMedia({ ...baseQuery, search: "summer" }, USER, [ROOT]).rows).toEqual(
            []
        );
    });
});

describe("tag filtering", () => {
    it("requires every selected tag", () => {
        const both = addItem(1, { title: "Both", durationMs: 1, size: 1 });
        addItem(2, { title: "One", durationMs: 1, size: 1 });

        const drama = tagRepo.ensureTag("genre", "Drama", null);
        const noir = tagRepo.ensureTag("genre", "Noir", null);

        tagRepo.assign({ mediaId: both, tagId: drama, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: both, tagId: noir, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: id(2), tagId: drama });

        const result = mediaRepo.listMedia({ ...baseQuery, tags: [drama, noir] }, USER, [ROOT]);

        expect(result.rows.map((row) => row.id)).toEqual([both]);
    });

    it("combines with a text search rather than replacing it", () => {
        const match = addItem(1, { title: "Summer Rain", durationMs: 1, size: 1 });
        const other = addItem(2, { title: "Summer Sun", durationMs: 1, size: 1 });

        for (const [mediaId, title] of [
            [match, "Summer Rain"],
            [other, "Summer Sun"],
        ] as const) {
            searchRepo.upsertDocument({
                mediaId,
                filename: "",
                title,
                performers: "",
                series: "",
                studio: "",
                tags: "",
                attributes: "",
                notes: "",
            });
        }

        const drama = tagRepo.ensureTag("genre", "Drama", null);
        tagRepo.assign({ mediaId: match, tagId: drama, userId: null, createdById: USER });

        const result = mediaRepo.listMedia(
            { ...baseQuery, search: "summer", tags: [drama] },
            USER,
            [ROOT]
        );

        expect(result.rows.map((row) => row.id)).toEqual([match]);
    });
});

describe("watched", () => {
    /**
     * `watchedAt` is stored rather than derived, and these are the two reasons (§14b).
     *
     * "Opened at all" marks a video watched for a mistaken click; "reached the end" is wrong
     * for the three-hour film you stopped ten minutes early. Both are free -- no column, no
     * writes -- and neither can be corrected by hand, which is the failure that matters.
     */
    it("filters both ways, and to nothing when not asked", () => {
        const seen = addItem(1, { title: "Seen", durationMs: 1, size: 1 });
        const unseen = addItem(2, { title: "Unseen", durationMs: 1, size: 1 });

        userMediaRepo.markWatched(USER, seen);

        const ids = (watched?: "yes" | "no") =>
            mediaRepo.listMedia({ ...baseQuery, watched }, USER, [ROOT]).rows.map((row) => row.id);

        expect(ids("yes")).toEqual([seen]);
        expect(ids("no")).toEqual([unseen]);
        expect(new Set(ids())).toEqual(new Set([seen, unseen]));
    });

    it("counts an item nobody has a row for as unwatched", () => {
        const item = addItem(1, { title: "Untouched", durationMs: 1, size: 1 });

        // The overlay is a LEFT JOIN and most items have no row at all, so "unwatched" has
        // to mean "no mark" rather than "a row saying no" -- otherwise the filter would
        // return nothing on a fresh library, which is every library at first.
        expect(
            mediaRepo.listMedia({ ...baseQuery, watched: "no" }, USER, [ROOT]).rows.map((r) => r.id)
        ).toEqual([item]);
    });

    it("is the viewer's own, never the overlay's", () => {
        const item = addItem(1, { title: "Theirs", durationMs: 1, size: 1 });

        userMediaRepo.markWatched(OWNER, item);

        // What somebody has watched is their history rather than a judgement about the item,
        // so a shared filter resolved against its owner must not answer with theirs (§6) --
        // the same rule `hidden` follows.
        expect(
            mediaRepo
                .listMedia({ ...baseQuery, watched: "no", minRating: 1 }, USER, [ROOT], OWNER)
                .rows.map((row) => row.id)
        ).toEqual([]);
        expect(
            mediaRepo
                .listMedia({ ...baseQuery, watched: "no" }, USER, [ROOT], OWNER)
                .rows.map((row) => row.id)
        ).toEqual([item]);
    });

    it("does not move the timestamp on a rewatch, and a manual mark can be cleared", () => {
        const item = addItem(1, { title: "Again", durationMs: 1, size: 1 });

        userMediaRepo.markWatched(USER, item);
        const first = sharedDb
            .prepare(`SELECT "watchedAt" FROM "UserMedia" WHERE "userId" = ? AND "mediaId" = ?`)
            .get(USER, item) as { watchedAt: string };

        // Automatic marking only ever sets, and only when unset: that is what "it survives a
        // rewatch" means, and it keeps the column saying when you *first* finished with the
        // item rather than sliding forward every time the file is opened.
        userMediaRepo.markWatched(USER, item);
        expect(
            sharedDb
                .prepare(`SELECT "watchedAt" FROM "UserMedia" WHERE "userId" = ? AND "mediaId" = ?`)
                .get(USER, item)
        ).toEqual(first);

        // By hand is the other half, and it goes both ways.
        userMediaRepo.setWatched(USER, item, false);
        expect(
            mediaRepo.listMedia({ ...baseQuery, watched: "no" }, USER, [ROOT]).rows.map((r) => r.id)
        ).toEqual([item]);
    });
});

describe("note", () => {
    /**
     * `UserMedia.note` is per-user, and that is the whole of its access control (§6).
     *
     * It is the only field on the detail panel nobody else can read -- tags are the
     * library's, the rating is shared -- so if the column were ever read without the join's
     * `userId`, a reminder written on a shared library would be visible to the household.
     */
    it("is the writer's own and nobody else's", () => {
        const item = addItem(1, { title: "Annotated", durationMs: 1, size: 1 });

        userMediaRepo.setNote(USER, item, "Ask about the audio");

        expect(mediaRepo.findDetail(item, USER, [ROOT])?.note).toBe("Ask about the audio");
        expect(mediaRepo.findDetail(item, OWNER, [ROOT])?.note).toBeNull();
    });

    /**
     * Empty is NULL, like every boolean in the schema and for the same reason: "" and "no
     * note" are one state, and storing both would make every reader check for two.
     *
     * It is also what makes clearing a note work without a second endpoint -- the text box
     * sends what is in it, and what is in it is "".
     */
    it("stores an emptied note as no note at all", () => {
        const item = addItem(1, { title: "Cleared", durationMs: 1, size: 1 });

        userMediaRepo.setNote(USER, item, "Temporary");
        userMediaRepo.setNote(USER, item, "");
        expect(mediaRepo.findDetail(item, USER, [ROOT])?.note).toBeNull();

        userMediaRepo.setNote(USER, item, "Temporary");
        userMediaRepo.setNote(USER, item, "   \n  ");
        expect(mediaRepo.findDetail(item, USER, [ROOT])?.note).toBeNull();

        userMediaRepo.setNote(USER, item, "Temporary");
        userMediaRepo.setNote(USER, item, null);
        expect(mediaRepo.findDetail(item, USER, [ROOT])?.note).toBeNull();
    });

    /**
     * The column's CHECK is on the *stored* length, so trimming has to happen before the
     * write rather than after validation somewhere upstream. A note pasted at exactly the
     * cap with a trailing newline is a note, not a constraint failure from three layers down.
     */
    it("trims before the length check rather than after it", () => {
        const item = addItem(1, { title: "Long", durationMs: 1, size: 1 });
        const atTheCap = "x".repeat(2000);

        expect(() => userMediaRepo.setNote(USER, item, `  ${atTheCap}\n`)).not.toThrow();
        expect(mediaRepo.findDetail(item, USER, [ROOT])?.note).toBe(atTheCap);
    });

    /** A note on an item the viewer has never otherwise touched still needs a row. */
    it("creates the overlay row it writes into", () => {
        const item = addItem(1, { title: "Untouched", durationMs: 1, size: 1 });

        userMediaRepo.setNote(USER, item, "First thing written here");

        expect(mediaRepo.findDetail(item, USER, [ROOT])?.note).toBe("First thing written here");
        // Writing a note is not an opinion about the item, and must not invent one.
        expect(mediaRepo.findDetail(item, USER, [ROOT])?.rating).toBeNull();
    });
});

/**
 * The art route's one statement: the artifact, only if the viewer may see the item. Its
 * visibility must agree with `findDetail` — a tile that draws for an item whose detail page is
 * a not-found tells somebody the item exists.
 */
describe("findVisibleArtifact", () => {
    const COVER = { effectiveCover: true } as const;

    const addCover = (mediaId: string, ordinal = 0) =>
        artifactRepo.upsert({
            mediaId,
            kind: "cover",
            ordinal,
            relPath: `art/${mediaId}/cover-${ordinal}.webp`,
        });

    const agree = (mediaId: string, rootIds: string[], expected: boolean): void => {
        expect(mediaRepo.findVisibleArtifact(mediaId, rootIds, COVER) !== undefined).toBe(expected);
        expect(mediaRepo.findDetail(mediaId, USER, rootIds) !== undefined).toBe(expected);
    };

    it("sees an item in a reachable root", () => {
        const item = addItem(1, { title: "Here", durationMs: 1, size: 1 });
        addCover(item);

        agree(item, [ROOT], true);
    });

    it("does not see an item outside the viewer's roots, or with no roots at all", () => {
        const item = addItem(1, { title: "Elsewhere", durationMs: 1, size: 1 });
        addCover(item);

        agree(item, ["bbbbbbbb-0000-4000-8000-000000000000"], false);
        agree(item, [], false);
    });

    it("does not see an item whose original is no longer active", () => {
        const item = addItem(1, { title: "Trashed", durationMs: 1, size: 1 });
        addCover(item);
        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'trashed'`).run();

        agree(item, [ROOT], false);
    });

    /** The trash page, which is admin-only, shows each trashed item's cover (§10). */
    it("sees a trashed item's artifacts only when asked to, and still only in reachable roots", () => {
        const item = addItem(1, { title: "In the bin", durationMs: 1, size: 1 });
        addCover(item);
        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'trashed'`).run();

        const trashed = { includeTrashed: true };

        expect(mediaRepo.findVisibleArtifact(item, [ROOT], COVER, trashed)).toBeDefined();
        expect(
            mediaRepo.findVisibleArtifact(
                item,
                ["bbbbbbbb-0000-4000-8000-000000000000"],
                COVER,
                trashed
            )
        ).toBeUndefined();

        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'missing'`).run();

        expect(mediaRepo.findVisibleArtifact(item, [ROOT], COVER, trashed)).toBeUndefined();
    });

    it("does not see an item that does not exist", () => {
        agree(id(404), [ROOT], false);
    });

    it("serves the chosen cover over the generated one, and a named one by name", () => {
        const item = addItem(1, { title: "Chosen", durationMs: 1, size: 1 });
        const generated = addCover(item, 0);
        const alternate = addCover(item, 2);

        expect(mediaRepo.findVisibleArtifact(item, [ROOT], COVER)?.id).toBe(generated.id);

        sharedDb
            .prepare(`UPDATE "Media" SET "coverArtifactId" = ? WHERE "id" = ?`)
            .run(alternate.id, item);

        expect(mediaRepo.findVisibleArtifact(item, [ROOT], COVER)?.id).toBe(alternate.id);
        expect(
            mediaRepo.findVisibleArtifact(item, [ROOT], {
                effectiveCover: false,
                kind: "cover",
                ordinal: 0,
            })?.id
        ).toBe(generated.id);
    });

    it("finds nothing for a visible item that lacks the artifact", () => {
        const item = addItem(1, { title: "Bare", durationMs: 1, size: 1 });

        expect(mediaRepo.findVisibleArtifact(item, [ROOT], COVER)).toBeUndefined();
    });
});

/**
 * What the filter panel may offer, and what each value holds (§5c, §20).
 *
 * Two questions and two queries, which is the arrangement that replaced one query pretending
 * to answer both. Values come from `tagRepo.listFacetValues`, which reads the vocabulary and
 * never scans the library; counts come from `facetCountsForTags`, which is asked only about
 * the values on their way to the screen.
 *
 * The old shape discovered values by scanning the filtered media and grouping what it found.
 * That is proportional to the library, so it stopped at 5,000 candidates -- and on a library
 * larger than that, a tag applied to a single item was usually not in the sample and had no
 * chip at all. Nothing on screen said a value had been left out, which is what made it a
 * misleading panel rather than a slow one.
 */
describe("facet values", () => {
    it("lists a value carried by one item, whatever else the library holds", () => {
        // The reported failure, in miniature: one tagged item among many. Structurally this
        // can no longer depend on the library size, because the listing query takes no filter
        // and reaches `Media` only to check the item is listable.
        for (let i = 0; i < 50; i += 1) {
            addItem(i + 1, { title: `Item ${i}`, durationMs: 1, size: 1 });
        }

        const lonely = addItem(99, { title: "The tagged one", durationMs: 1, size: 1 });
        const keyword = tagRepo.ensureTag("tag", "Interesting", USER);

        tagRepo.assign({ mediaId: lonely, tagId: keyword, userId: USER, createdById: USER });

        expect(tagRepo.listFacetValues({ owner: USER, limit: 20 })).toEqual([
            expect.objectContaining({ name: "Interesting", uses: 1 }),
        ]);
    });

    it("leaves out a tag nothing carries", () => {
        // A tag on no items is not a filter, it is a row for the vocabulary screen to tidy
        // up. Offering it guarantees an empty grid and explains nothing.
        addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        tagRepo.ensureTag("genre", "Unused", null);

        expect(tagRepo.listFacetValues({ owner: null, limit: 20 })).toEqual([]);
    });

    it("orders by how much the library uses each value", () => {
        const one = addItem(1, { title: "One", durationMs: 1, size: 1 });
        const two = addItem(2, { title: "Two", durationMs: 1, size: 1 });
        const common = tagRepo.ensureTag("genre", "Common", null);
        const rare = tagRepo.ensureTag("genre", "Rare", null);

        tagRepo.assign({ mediaId: one, tagId: common, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: two, tagId: common, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: one, tagId: rare, userId: null, createdById: USER });

        expect(tagRepo.listFacetValues({ owner: null, limit: 20 }).map((row) => row.name)).toEqual([
            "Common",
            "Rare",
        ]);
    });

    it("narrows by name, so a value past the cap is still reachable", () => {
        // The expanded list is a ceiling, so the search box cannot be a filter over what was
        // already sent -- a value past the ceiling would be unreachable by the one control
        // that exists to reach it.
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });

        for (const name of ["Aurora", "Beacon", "Cinder"]) {
            tagRepo.assign({
                mediaId: video,
                tagId: tagRepo.ensureTag("studio", name, null, USER),
                userId: null,
                createdById: USER,
            });
        }

        expect(
            tagRepo
                .listFacetValues({ owner: null, limit: 20, search: "bea" })
                .map((row) => row.name)
        ).toEqual(["Beacon"]);
    });

    it("lists only the library vocabulary for the public group", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const shared = tagRepo.ensureTag("genre", "Drama", null);
        const mine = tagRepo.ensureTag("tag", "Mine", USER);

        tagRepo.assign({ mediaId: video, tagId: shared, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: video, tagId: mine, userId: USER, createdById: USER });

        expect(tagRepo.listFacetValues({ owner: null, limit: 20 }).map((row) => row.name)).toEqual([
            "Drama",
        ]);
    });

    it("lists the viewer own tags for the private group, and nobody else", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const mine = tagRepo.ensureTag("tag", "Mine", USER);
        const theirs = tagRepo.ensureTag("tag", "Theirs", OWNER);

        tagRepo.assign({ mediaId: video, tagId: mine, userId: USER, createdById: USER });
        tagRepo.assign({ mediaId: video, tagId: theirs, userId: OWNER, createdById: OWNER });

        // Seeing it would disclose both that the tag exists and what carries it (§6).
        expect(tagRepo.listFacetValues({ owner: USER, limit: 20 }).map((row) => row.name)).toEqual([
            "Mine",
        ]);
    });

    it("reports a total per facet beyond what it returns", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });

        for (const name of ["Drama", "Noir", "Comedy"]) {
            tagRepo.assign({
                mediaId: video,
                tagId: tagRepo.ensureTag("genre", name, null, USER),
                userId: null,
                createdById: USER,
            });
        }

        // Capped at one, it still knows there are three: the total is counted before the cap.
        expect(tagRepo.listFacetValues({ owner: null, limit: 1 })).toEqual([
            expect.objectContaining({ kind: "genre", total: 3 }),
        ]);
    });

    it("caps each facet independently", () => {
        // One large facet must not crowd every other facet out of a single global limit.
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });

        for (const name of ["A", "B", "C"]) {
            tagRepo.assign({
                mediaId: video,
                tagId: tagRepo.ensureTag("genre", name, null, USER),
                userId: null,
                createdById: USER,
            });
        }

        tagRepo.assign({ mediaId: video, tagId: tagRepo.ensureTag("studio", "Aurora", null) });

        const values = tagRepo.listFacetValues({ owner: null, limit: 2 });

        expect(values.filter((row) => row.kind === "genre")).toHaveLength(2);
        expect(values.filter((row) => row.kind === "studio")).toHaveLength(1);
    });
});

describe("facetCountsForTags", () => {
    it("counts within the current filter, not the whole library", () => {
        // A panel offering "Drama (12)" that returns eight results looks like corrupt data
        // and is near impossible to diagnose from a bug report.
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const image = addItem(2, { title: "An Image", durationMs: 1, size: 1 });

        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" = ?`).run(image);

        const drama = tagRepo.ensureTag("genre", "Drama", null);
        tagRepo.assign({ mediaId: video, tagId: drama, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: image, tagId: drama, userId: null, createdById: USER });

        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [ROOT], [drama], "public")).toEqual([
            expect.objectContaining({ name: "Drama", count: 2 }),
        ]);

        expect(
            mediaRepo.facetCountsForTags(
                { ...baseQuery, kind: "video" },
                USER,
                [ROOT],
                [drama],
                "public"
            )
        ).toEqual([expect.objectContaining({ name: "Drama", count: 1 })]);
    });

    /**
     * A value the current filter excludes entirely still gets a row, with a zero.
     *
     * The list is the vocabulary now, so the chip is on screen either way; the count is what
     * says whether clicking it would help. Dropping the row would put a hole in a list that
     * claims to be complete.
     */
    it("returns a zero rather than nothing for a value the filter excludes", () => {
        const image = addItem(1, { title: "An Image", durationMs: 1, size: 1 });

        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" = ?`).run(image);

        const drama = tagRepo.ensureTag("genre", "Drama", null);
        tagRepo.assign({ mediaId: image, tagId: drama, userId: null, createdById: USER });

        expect(
            mediaRepo.facetCountsForTags(
                { ...baseQuery, kind: "video" },
                USER,
                [ROOT],
                [drama],
                "public"
            )
        ).toEqual([expect.objectContaining({ name: "Drama", count: 0 })]);
    });

    it("gives two viewers the same public count for the same tag", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const shared = tagRepo.ensureTag("genre", "Drama", null);

        tagRepo.assign({ mediaId: video, tagId: shared, userId: null, createdById: USER });

        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [ROOT], [shared], "public")).toEqual(
            mediaRepo.facetCountsForTags(baseQuery, OWNER, [ROOT], [shared], "public")
        );
    });

    it("counts the viewer own assignments in the private pass", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const mine = tagRepo.ensureTag("tag", "Mine", USER);

        tagRepo.assign({ mediaId: video, tagId: mine, userId: USER, createdById: USER });

        expect(
            mediaRepo
                .facetCountsForTags(baseQuery, USER, [ROOT], [mine], "private")
                .map((row) => row.count)
        ).toEqual([1]);
    });

    /**
     * A selected tag is counted by id so it cannot fall out of the panel while it is the
     * thing doing the filtering — and that query used to ignore scope entirely. It reads
     * `FROM "Tag" WHERE "id" IN (...)`, so every selected id came back in *both* passes, with
     * the scope predicate only zeroing the count. A private tag you had selected therefore
     * appeared in the public Tags section, where removing it was the only way to find out
     * which one it was.
     */
    it("keeps a selected private tag out of the public pass", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const mine = tagRepo.ensureTag("tag", "Mine", USER);

        tagRepo.assign({ mediaId: video, tagId: mine, userId: USER, createdById: USER });

        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [ROOT], [mine], "public")).toEqual([]);
        expect(
            mediaRepo
                .facetCountsForTags(baseQuery, USER, [ROOT], [mine], "private")
                .map((row) => row.name)
        ).toEqual(["Mine"]);
    });

    it("keeps a selected public tag out of the private pass", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const shared = tagRepo.ensureTag("tag", "Drama", null);

        tagRepo.assign({ mediaId: video, tagId: shared, userId: null, createdById: USER });

        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [ROOT], [shared], "private")).toEqual(
            []
        );
    });

    /** And never another person tag, selected or not. */
    it("keeps a selected tag belonging to somebody else out of both", () => {
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const theirs = tagRepo.ensureTag("tag", "Theirs", OWNER);

        tagRepo.assign({ mediaId: video, tagId: theirs, userId: OWNER, createdById: OWNER });

        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [ROOT], [theirs], "public")).toEqual(
            []
        );
        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [ROOT], [theirs], "private")).toEqual(
            []
        );
    });
});

describe("access control", () => {
    it("returns nothing when the user has no accessible roots", () => {
        addItem(1, { title: "A Video", durationMs: 1, size: 1 });

        expect(mediaRepo.listMedia(baseQuery, USER, []).rows).toEqual([]);
        expect(mediaRepo.countMedia(baseQuery, USER, [])).toBe(0);
    });

    it("applies to facet counts too", () => {
        // Facets are a second path to the library, and a count is enough to reveal that
        // something exists in a root the viewer cannot see.
        const video = addItem(1, { title: "A Video", durationMs: 1, size: 1 });
        const drama = tagRepo.ensureTag("genre", "Drama", null);

        tagRepo.assign({ mediaId: video, tagId: drama });

        // A count is enough to reveal that something exists in a root the viewer cannot see,
        // so the answer is a zero rather than the number the library would give.
        expect(mediaRepo.facetCountsForTags(baseQuery, USER, [], [drama], "public")).toEqual([
            expect.objectContaining({ count: 0 }),
        ]);
    });
});

describe("resolving ratings against somebody other than the viewer", () => {
    /**
     * A shared filter its owner marked as resolving against themselves (§6).
     *
     * The rest of the query is unaffected: access, hidden items and the ratings shown on each
     * tile all stay the viewer's. Only the question the filter asks moves.
     */
    const rate = (userId: string, mediaId: string, rating: number | null, hidden = false): void => {
        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "rating", "hidden", "updatedAt")
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT("userId", "mediaId") DO UPDATE
                SET "rating" = excluded."rating", "hidden" = excluded."hidden"`
        ).run(userId, mediaId, rating, hidden ? 1 : null);
    };

    beforeEach(() => {
        addItem(1, { title: "Ours", durationMs: 1, size: 1 });
        addItem(2, { title: "Theirs", durationMs: 2, size: 2 });
    });

    it("filters by the viewer's ratings when no overlay is given", () => {
        rate(USER, id(1), 5);
        rate(OWNER, id(2), 5);

        const rows = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT]).rows;

        expect(rows.map((row) => row.title)).toEqual(["Ours"]);
    });

    it("filters by the other person's ratings when one is", () => {
        rate(USER, id(1), 5);
        rate(OWNER, id(2), 5);

        const rows = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT], OWNER).rows;

        expect(rows.map((row) => row.title)).toEqual(["Theirs"]);
    });

    /**
     * The overlay decides what is asked, never what is shown.
     *
     * Opening somebody's shared filter must not put their stars on your tiles — you would
     * have no way to tell them from your own, and rating from that screen would look like an
     * edit to a value you could already see.
     */
    it("still reports the viewer's own rating on each row", () => {
        rate(OWNER, id(2), 5);
        rate(USER, id(2), 2);

        const [row] = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT], OWNER).rows;

        expect(row.title).toBe("Theirs");
        expect(row.rating).toBe(2);
    });

    it("reports no rating at all for an item the viewer has never rated", () => {
        rate(OWNER, id(2), 5);

        const [row] = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT], OWNER).rows;

        expect(row.rating).toBeNull();
    });

    /**
     * Hiding is a standing instruction, not a predicate.
     *
     * If the overlay governed it, opening a shared filter would resurface everything the
     * viewer had put away — the one thing hiding exists to prevent.
     */
    it("keeps hidden items hidden, whoever's ratings are being asked about", () => {
        rate(OWNER, id(1), 5);
        rate(OWNER, id(2), 5);
        rate(USER, id(1), null, true);

        const rows = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT], OWNER).rows;

        expect(rows.map((row) => row.title)).toEqual(["Theirs"]);
    });

    it("applies to favourites and to unrated as well as to a minimum rating", () => {
        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "favorite", "updatedAt")
             VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
        ).run(OWNER, id(2));
        rate(OWNER, id(1), 3);

        expect(
            mediaRepo
                .listMedia({ ...baseQuery, favorite: true }, USER, [ROOT], OWNER)
                .rows.map((row) => row.title)
        ).toEqual(["Theirs"]);

        expect(
            mediaRepo
                .listMedia({ ...baseQuery, unrated: true }, USER, [ROOT], OWNER)
                .rows.map((row) => row.title)
        ).toEqual(["Theirs"]);
    });

    it("sorts by the other person's ratings too, so the order matches the filter", () => {
        rate(OWNER, id(1), 1);
        rate(OWNER, id(2), 5);
        // The viewer's own ratings are the opposite way round, so a sort that ignored the
        // overlay would produce the reverse and look plausible.
        rate(USER, id(1), 5);
        rate(USER, id(2), 1);

        const rows = mediaRepo.listMedia(
            { ...baseQuery, sort: "rating", direction: "desc" },
            USER,
            [ROOT],
            OWNER
        ).rows;

        expect(rows.map((row) => row.title)).toEqual(["Theirs", "Ours"]);
    });

    it("counts the same set it lists", () => {
        rate(OWNER, id(2), 5);

        expect(mediaRepo.countMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT], OWNER)).toBe(1);
        expect(mediaRepo.countMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT])).toBe(0);
    });

    /**
     * An overlay naming the viewer is not an overlay.
     *
     * The owner opening their own shared filter takes this path, and it has to collapse to the
     * ordinary query rather than a self-join saying the same thing more slowly.
     */
    it("behaves identically when the overlay is the viewer themselves", () => {
        rate(USER, id(1), 5);

        const withOverlay = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT], USER);
        const without = mediaRepo.listMedia({ ...baseQuery, minRating: 4 }, USER, [ROOT]);

        expect(withOverlay.rows.map((row) => row.id)).toEqual(without.rows.map((row) => row.id));
    });

    it("ignores an overlay on a query that never asks about ratings", () => {
        rate(USER, id(1), 5);

        const rows = mediaRepo.listMedia(baseQuery, USER, [ROOT], OWNER).rows;

        expect(rows).toHaveLength(2);
    });

    it("applies when only the ids are wanted, so a freeze matches what was previewed", () => {
        rate(OWNER, id(2), 5);

        expect(
            mediaRepo.listMediaIds({ ...baseQuery, minRating: 4 }, USER, [ROOT], 100, OWNER)
        ).toEqual([id(2)]);
    });
});

/**
 * The detail lookup, which had no test at all until it broke in production.
 *
 * `db.prepare` compiles SQL when the function is called, not when the module loads, so an
 * untested query is an uncompiled one. `findDetail` selected `f."size"` and friends out of an
 * alias that `BASE_FROM` had stopped providing, and every request for an item's detail page --
 * and every attempt to serve its bytes, which resolves through here -- returned a 500 saying
 * only "no such column: f.size". The library grid kept working throughout, because it reads
 * the denormalised `listSize`/`listRelPath` columns instead.
 *
 * So the first test is not about behaviour at all. It is about the statement compiling.
 */
describe("findDetail", () => {
    it("returns the item, its file and its root", () => {
        const mediaId = addItem(1, { title: "Item 1", durationMs: 1_000, size: 4_096 });

        const row = mediaRepo.findDetail(mediaId, USER, [ROOT]);

        expect(row).toMatchObject({
            id: mediaId,
            title: "Item 1",
            sizeBytes: 4_096,
            relPath: "Item 1.mp4",
            rootId: ROOT,
            rootLabel: "Videos",
        });
    });

    /** An item in a root the viewer cannot see is reported as absent, never as forbidden. */
    it("finds nothing in a root the viewer has no access to", () => {
        const mediaId = addItem(1, { title: "Item 1", durationMs: 1_000, size: 4_096 });

        expect(mediaRepo.findDetail(mediaId, USER, [])).toBeUndefined();
        expect(
            mediaRepo.findDetail(mediaId, USER, ["bbbbbbbb-0000-4000-8000-000000000000"])
        ).toBeUndefined();
    });

    /**
     * A trashed or missing file makes the item not-found rather than a row with null paths,
     * because serving bytes resolves through this and would otherwise fail further down with
     * something much less obvious than a 404.
     */
    it("finds nothing once the original file is no longer active", () => {
        const mediaId = addItem(1, { title: "Item 1", durationMs: 1_000, size: 4_096 });

        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'trashed'`).run();

        expect(mediaRepo.findDetail(mediaId, USER, [ROOT])).toBeUndefined();
    });
});

/**
 * Sort direction (§14).
 *
 * The regression is the omitted case. `direction` used to default to `desc` for every sort,
 * so asking for a title sort without saying which way round listed the library from Z to A —
 * and because the ordering was still perfectly stable and paging still worked, nothing about
 * it looked like a fault.
 */
describe("sort direction", () => {
    const titles = (query: Parameters<typeof mediaRepo.listMedia>[0]): (string | null)[] =>
        mediaRepo.listMedia(query, USER, [ROOT]).rows.map((row) => row.title);

    beforeEach(() => {
        addItem(1, { title: "Alpha", durationMs: 1_000, size: 100 });
        addItem(2, { title: "Bravo", durationMs: 2_000, size: 200 });
        addItem(3, { title: "Charlie", durationMs: 3_000, size: 300 });
    });

    it("sorts titles A–Z when no direction is given", () => {
        const query = { ...baseQuery, sort: "title", direction: undefined };

        expect(titles(query as typeof baseQuery)).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    it("still sorts everything else with the interesting end first by default", () => {
        const query = { ...baseQuery, sort: "duration", direction: undefined };

        expect(titles(query as typeof baseQuery)).toEqual(["Charlie", "Bravo", "Alpha"]);
    });

    it("reverses when asked", () => {
        expect(
            titles({ ...baseQuery, sort: "title", direction: "desc" } as typeof baseQuery)
        ).toEqual(["Charlie", "Bravo", "Alpha"]);
        expect(
            titles({ ...baseQuery, sort: "duration", direction: "asc" } as typeof baseQuery)
        ).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    /**
     * The tiebreaker has to turn with the sort, or paging breaks in a way no single page
     * shows: rows with equal values would be ordered one way by the sort column and the other
     * by `m.id`, and the boundary between two pages would repeat or skip them.
     */
    it("walks every item exactly once in either direction", () => {
        for (const direction of ["asc", "desc"] as const) {
            const seen = pageThrough(
                { ...baseQuery, sort: "title", direction } as typeof baseQuery,
                2
            );

            expect(new Set(seen).size).toBe(3);
            expect(seen).toHaveLength(3);
        }
    });
});

describe("sort by last viewed", () => {
    const viewed = (userId: string, mediaId: string, at: string): void => {
        sharedDb
            .prepare(
                `INSERT INTO "UserMedia" ("userId", "mediaId", "viewCount", "lastViewedAt", "updatedAt")
                 VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)`
            )
            .run(userId, mediaId, at);
    };

    const titles = (
        direction: "asc" | "desc" | undefined,
        overlayUserId?: string
    ): (string | null)[] =>
        mediaRepo
            .listMedia(
                { ...baseQuery, sort: "lastViewed", direction } as typeof baseQuery,
                USER,
                [ROOT],
                overlayUserId
            )
            .rows.map((row) => row.title);

    beforeEach(() => {
        addItem(1, { title: "Last week", durationMs: 1, size: 1 });
        addItem(2, { title: "Never", durationMs: 1, size: 1 });
        addItem(3, { title: "Yesterday", durationMs: 1, size: 1 });

        viewed(USER, id(1), "2026-09-24 12:00:00");
        viewed(USER, id(3), "2026-09-30 12:00:00");
    });

    it("puts the most recent first by default", () => {
        expect(titles(undefined)).toEqual(["Yesterday", "Last week", "Never"]);
    });

    /**
     * SQLite would put the never-viewed first when ascending, and in a real library that is
     * most of it: "longest ago" would open on thousands of items nobody has seen, ahead of the
     * one watched a year back that the order was asked for.
     */
    it("keeps the never-viewed last when reversed", () => {
        expect(titles("asc")).toEqual(["Last week", "Yesterday", "Never"]);
    });

    it("is the viewer's history, never a shared filter's owner's", () => {
        viewed(OWNER, id(2), "2026-10-01 12:00:00");

        expect(titles("desc", OWNER)).toEqual(["Yesterday", "Last week", "Never"]);
    });

    /**
     * Paging has to join the viewer's row for this sort, which no other non-rating sort does --
     * leave it out and the query names `um` with nothing joined under that name.
     */
    it("walks every item exactly once across pages", () => {
        for (const direction of ["asc", "desc"] as const) {
            const seen = pageThrough(
                { ...baseQuery, sort: "lastViewed", direction } as typeof baseQuery,
                2
            );

            expect(new Set(seen).size).toBe(3);
            expect(seen).toHaveLength(3);
        }
    });
});

describe("sort by resolution", () => {
    const sized = (mediaId: string, width: number, height: number): void => {
        sharedDb
            .prepare(`UPDATE "Media" SET "width" = ?, "height" = ? WHERE "id" = ?`)
            .run(width, height, mediaId);
    };

    /** The short side, as the resolution filter measures it: an upright 1080×1920 is 1080p. */
    it("orders by the shorter side, so a portrait frame is not promoted", () => {
        sized(addItem(1, { title: "Portrait 1080", durationMs: 1, size: 1 }), 1_080, 1_920);
        sized(addItem(2, { title: "Landscape 1440", durationMs: 1, size: 1 }), 2_560, 1_440);
        sized(addItem(3, { title: "Landscape 720", durationMs: 1, size: 1 }), 1_280, 720);

        expect(
            mediaRepo
                .listMedia(
                    { ...baseQuery, sort: "resolution", direction: undefined } as typeof baseQuery,
                    USER,
                    [ROOT]
                )
                .rows.map((row) => row.title)
        ).toEqual(["Landscape 1440", "Portrait 1080", "Landscape 720"]);
    });
});

/**
 * The home page's shelves (§6), and what each one reads (§20).
 *
 * On the NAS a statement costs the pages it touches, so a shelf that returns twelve rows must
 * not walk the library to find them. Two of these did, through a plan the planner chose with no
 * statistics to go on; the plan assertions hold the shape that replaced it.
 */
describe("home shelves", () => {
    /** The plan SQLite chooses for the statement a repo call prepared, with its parameters. */
    const planFor = (run: () => void, match: string, params: Record<string, unknown>): string => {
        const prepare = vi.spyOn(sharedDb, "prepare");

        try {
            run();

            const sql = prepare.mock.calls
                .map(([text]) => text)
                .find((text) => text.includes(match));

            if (!sql) {
                throw new Error(`no statement containing ${match}`);
            }

            prepare.mockRestore();

            return (
                sharedDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[]
            )
                .map((row) => row.detail)
                .join("\n");
        } finally {
            prepare.mockRestore();
        }
    };

    it("lists recently viewed newest first, leaving out the unviewed and the hidden", () => {
        const [old, recent, finished, hidden, rated] = [1, 2, 3, 4, 5].map((n) =>
            addItem(n, { title: `Item ${n}`, durationMs: 1000, size: 1 })
        );

        // An overlay row with no view -- rated, never watched -- so not on the shelf.
        userMediaRepo.setRating(USER, rated, 4);

        for (const [mediaId, at] of [
            [old, "2026-01-01 00:00:00"],
            [recent, "2026-02-01 00:00:00"],
            [finished, "2026-03-01 00:00:00"],
            [hidden, "2026-04-01 00:00:00"],
        ] as const) {
            userMediaRepo.recordView(USER, mediaId, mediaId === finished);
            db.prepare(
                `UPDATE "UserMedia" SET "lastViewedAt" = ? WHERE "userId" = ? AND "mediaId" = ?`
            ).run(at, USER, mediaId);
        }

        userMediaRepo.setHidden(USER, hidden, true);

        expect(mediaRepo.listRecentlyViewed(USER, [ROOT], 12).map((row) => row.id)).toEqual([
            finished,
            recent,
            old,
        ]);
        expect(mediaRepo.listRecentlyViewed(USER, [ROOT], 1).map((row) => row.id)).toEqual([
            finished,
        ]);
    });

    it("walks the viewer's view index for recently viewed, never the library", () => {
        const plan = planFor(
            () => mediaRepo.listRecentlyViewed(USER, [ROOT], 12),
            `"lastViewedAt" IS NOT NULL`,
            { userId: USER, root0: ROOT, limit: 12 }
        );

        expect(plan.split("\n")[0]).toContain("idx_UserMedia_viewed");
        expect(plan).not.toContain("idx_Media_list_");
        expect(plan).not.toContain("TEMP B-TREE");
    });

    it("looks items up by id rather than scanning a library for them", () => {
        addItem(1, { title: "Item", durationMs: 1, size: 1 });

        const plan = planFor(() => mediaRepo.listByIds([id(1)], USER, [ROOT]), "json_each(:ids)", {
            userId: USER,
            root0: ROOT,
            ids: JSON.stringify([id(1)]),
        });

        expect(plan).not.toContain("idx_Media_list_");
        expect(plan).toMatch(/SEARCH m USING .*\(id=\?\)/);
    });

    it("samples a shuffle: distinct, matching, as many as asked, and different per seed", () => {
        for (let n = 1; n <= 30; n += 1) {
            addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
        }

        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "durationMs" > 20`).run();

        const sample = (seed: number) =>
            mediaRepo.shuffledIds({ ...baseQuery, kind: "video" }, USER, [ROOT], 8, seed);
        const videos = new Set(
            (
                db.prepare(`SELECT "id" FROM "Media" WHERE "kind" = 'video'`).all() as {
                    id: string;
                }[]
            ).map((row) => row.id)
        );

        expect(sample(1)).toHaveLength(8);
        expect(new Set(sample(1)).size).toBe(8);
        expect(sample(1).every((mediaId) => videos.has(mediaId))).toBe(true);
        expect(sample(1)).not.toEqual(sample(2));
    });
});

/**
 * Text matches, resolved to items (§5c, §20): through the rowid index rather than the documents,
 * and -- for a mentions filter that matched little -- as the query's starting point.
 *
 * Two plans for one question, so the behaviour is pinned against a model on both sides of the
 * switch: a name in twenty files is driven from the matches, one in a hundred and twenty (past
 * `MIN_DRIVING_MATCHES`) is a walk of `Media`, and the answers must not depend on which.
 */
describe("resolving text matches", () => {
    const TAGGER = USER;

    /** What the worker's `mentionMatch` pass writes: every document matched by the one rule. */
    const matchMentions = (): void => {
        const matcher = buildTagMatcher(mentionRepo.vocabulary());

        mentionRepo.writeChanged(
            mentionRepo.documentsAfter(0, 100_000).map((document) => ({
                mediaId: document.mediaId,
                mentions: mentionsIn(document.texts, matcher),
            }))
        );
    };

    const indexText = (mediaId: string, title: string): void => {
        searchRepo.upsertDocument({
            mediaId,
            filename: "",
            title,
            performers: "",
            tags: "",
            attributes: "",
            notes: "",
            ocr: "",
            variants: "",
        });
    };

    /** The statement a repo call prepared that contains `match`, with its plan. */
    const planFor = (run: () => void, match: string, params: Record<string, unknown>): string => {
        const prepare = vi.spyOn(sharedDb, "prepare");

        try {
            run();

            const sql = prepare.mock.calls
                .map(([text]) => text)
                .filter((text) => text.includes(match))
                .pop();

            if (!sql) {
                throw new Error(`no statement containing ${match}`);
            }

            prepare.mockRestore();

            return (
                sharedDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[]
            )
                .map((row) => row.detail)
                .join("\n");
        } finally {
            prepare.mockRestore();
        }
    };

    interface Fixture {
        /** Each item: id, kind, the words in its document, whether it carries the tag. */
        items: { id: string; kind: "video" | "image"; text: string; tagged: string[] }[];
        tags: Record<string, string>;
    }

    /**
     * 160 items: "Aunt Margaret" named in 20 of them, "rain" in 120, a mix of kinds, some of
     * each already tagged, one hidden.
     */
    const givenLibrary = (): Fixture => {
        const tags = {
            margaret: tagRepo.ensureTag("performer", "Aunt Margaret", null),
            rain: tagRepo.ensureTag("tag", "rain", null),
        };
        const items: Fixture["items"] = [];

        for (let n = 1; n <= 160; n += 1) {
            const mediaId = addItem(n, { title: `Item ${n}`, durationMs: n, size: n });
            const kind = n % 3 === 0 ? "image" : "video";
            const words = [
                n <= 20 ? "aunt margaret" : n === 21 ? "margaret, an aunt" : "",
                n > 30 && n <= 150 ? "rain" : "",
                `item ${n}`,
            ].join(" ");
            const tagged = [
                ...(n % 4 === 0 ? [tags.margaret] : []),
                ...(n % 5 === 0 ? [tags.rain] : []),
            ];

            db.prepare(`UPDATE "Media" SET "kind" = ? WHERE "id" = ?`).run(kind, mediaId);
            indexText(mediaId, words);

            for (const tagId of tagged) {
                tagRepo.assign({ mediaId, tagId, userId: null, createdById: TAGGER });
            }

            items.push({ id: mediaId, kind, text: words, tagged });
        }

        userMediaRepo.setHidden(USER, id(2), true);
        matchMentions();

        return { items: items.filter((item) => item.id !== id(2)), tags };
    };

    /** What a mentions query should answer, worked out without SQL. */
    const expected = (
        fixture: Fixture,
        word: "margaret" | "rain",
        kind: "video" | "image" | undefined,
        without: boolean
    ): string[] =>
        fixture.items
            .filter((item) =>
                word === "margaret"
                    ? item.text.includes("aunt margaret")
                    : item.text.includes("rain")
            )
            .filter((item) => kind === undefined || item.kind === kind)
            .filter((item) => !without || !item.tagged.includes(fixture.tags[word]))
            .map((item) => item.id);

    it("answers a mentions query the same from the matches and from the library", () => {
        const fixture = givenLibrary();

        for (const word of ["margaret", "rain"] as const) {
            for (const kind of ["video", "image", undefined] as const) {
                for (const without of [true, false]) {
                    const query = {
                        ...baseQuery,
                        kind,
                        mentions: fixture.tags[word],
                        notTags: without ? [fixture.tags[word]] : undefined,
                    };
                    const want = expected(fixture, word, kind, without);

                    expect(mediaRepo.countMedia(query, USER, [ROOT])).toBe(want.length);
                    expect(pageThrough(query, 7).sort()).toEqual([...want].sort());
                    expect(mediaRepo.listMediaIds(query, USER, [ROOT], 1000).sort()).toEqual(
                        [...want].sort()
                    );
                }
            }
        }
    });

    it("pages a driven mentions query in the order the walk would", () => {
        const fixture = givenLibrary();

        for (const sort of ["addedAt", "title", "duration", "random"]) {
            for (const direction of ["asc", "desc"]) {
                const query = {
                    ...baseQuery,
                    sort,
                    direction,
                    seed: 11,
                    mentions: fixture.tags.margaret,
                } as unknown as typeof baseQuery;
                // The same filter as a walk: the search box over the same words.
                const walked = pageThrough(
                    { ...query, mentions: undefined, search: '"aunt margaret"' },
                    6
                );

                expect(pageThrough(query, 6)).toEqual(walked);
            }
        }
    });

    it("starts a mentions query that matched a few items from the matches", () => {
        const fixture = givenLibrary();
        const params = {
            userId: USER,
            root0: ROOT,
            kind: "video",
            mentions: fixture.tags.margaret,
            notTag0: fixture.tags.margaret,
        };
        const query = {
            ...baseQuery,
            kind: "video" as const,
            mentions: fixture.tags.margaret,
            notTags: [fixture.tags.margaret],
        };
        const count = planFor(
            () => mediaRepo.countMedia(query, USER, [ROOT]),
            "count(*) AS n",
            // Counted the way a page walks: the hidden item excluded by id, no overlay join.
            { ...params, hidden0: id(2) }
        );
        const page = planFor(
            () => mediaRepo.listMedia(query, USER, [ROOT]),
            "LIMIT :limit OFFSET :offset",
            // The viewer's one hidden item is excluded by id while paging.
            { ...params, limit: 61, offset: 0, hidden0: id(2) }
        );

        // From the tag's mentions, one probe per item; never a walk of the library.
        for (const plan of [count, page]) {
            expect(plan).toContain("SEARCH mm USING COVERING INDEX idx_MediaMention_tag");
            expect(plan).toContain("SCAN hit");
            expect(plan).not.toContain("idx_Media_list_");
        }
    });

    it("walks the library for a mentions query that matched too much to start from", () => {
        const fixture = givenLibrary();
        const plan = planFor(
            () =>
                mediaRepo.countMedia(
                    { ...baseQuery, kind: "video", mentions: fixture.tags.rain },
                    USER,
                    [ROOT]
                ),
            "count(*) AS n",
            {
                userId: USER,
                root0: ROOT,
                kind: "video",
                mentions: fixture.tags.rain,
                hidden0: id(2),
            }
        );

        expect(plan).toContain("idx_Media_list_");
        expect(plan).toContain("SEARCH MediaMention USING COVERING INDEX idx_MediaMention_tag");
    });

    it("never reads a document to find out which item a search matched", () => {
        givenLibrary();

        const plan = planFor(
            () => mediaRepo.countMedia({ ...baseQuery, search: "ra" }, USER, [ROOT]),
            "count(*) AS n",
            {
                userId: USER,
                root0: ROOT,
                match: `"ra" *`,
                mw0: `"ra" *`,
                pt0: "% ra%",
                ps0: "ra%",
                hidden0: id(2),
            }
        );

        expect(plan).toContain("SEARCH d USING COVERING INDEX idx_MediaSearchDoc_rowid_mediaId");
        expect(plan).not.toContain("INTEGER PRIMARY KEY");
    });

    it("scores a relevance search the same through the rowid index", () => {
        const fixture = givenLibrary();
        const weights = `0, 8, 10, 7, 3, 1, 2, 0.5, 1`;
        const direct = db
            .prepare(
                `SELECT "mediaId", bm25("MediaSearch", ${weights}) AS "score"
                   FROM "MediaSearch" WHERE "MediaSearch" MATCH ? ORDER BY "mediaId"`
            )
            .all(`"rain"`);
        const mapped = db
            .prepare(
                `SELECT "mediaId", "score" FROM (${searchRepo
                    .matchedIdsSql("match")
                    .replace(
                        `SELECT d."mediaId"`,
                        `SELECT d."mediaId", bm25("MediaSearch", ${weights}) AS "score"`
                    )}) ORDER BY "mediaId"`
            )
            .all({ match: `"rain"` });

        expect(mapped).toEqual(direct);
        expect(direct).toHaveLength(expected(fixture, "rain", undefined, false).length);
        expect(pageThrough({ ...baseQuery, search: "rain", sort: "relevance" }, 9).sort()).toEqual(
            expected(fixture, "rain", undefined, false).sort()
        );
    });
});

/**
 * Known and deliberately unfixed while transcoding is off (ARCHITECTURE.md §8). A `todo` rather
 * than a comment so it is printed by every test run, which is where somebody changing the
 * transcode path will see it.
 */
describe("listTranscodeCandidates", () => {
    it.todo(
        "reaches videos that need a rendition even when the first batch is all direct-play " +
            "(today: LIMIT with no ORDER BY or cursor, filtered afterwards in TypeScript)"
    );
});

/**
 * A title is the file's name, derived once; after a rename it went on saying the old name for
 * good (§12b). It follows the file now — unless it says something else, which was a choice.
 */
describe("retitleAfterMove", () => {
    const title = (mediaId: string): string | null =>
        (
            sharedDb.prepare(`SELECT "title" FROM "Media" WHERE "id" = ?`).get(mediaId) as {
                title: string | null;
            }
        ).title;

    it("follows the file to its new name", () => {
        const item = addItem(1, { title: "Old Name", durationMs: 1000, size: 1 });

        expect(mediaRepo.retitleAfterMove(item, "Old Name", "New Name")).toBe(true);
        expect(title(item)).toBe("New Name");
    });

    it("leaves a title that was not the old name's", () => {
        const item = addItem(2, { title: "Chosen Title", durationMs: 1000, size: 1 });

        expect(mediaRepo.retitleAfterMove(item, "Old Name", "New Name")).toBe(false);
        expect(title(item)).toBe("Chosen Title");
    });

    it("does nothing when only the folder changed", () => {
        const item = addItem(3, { title: "Same", durationMs: 1000, size: 1 });

        expect(mediaRepo.retitleAfterMove(item, "Same", "Same")).toBe(false);
    });
});
