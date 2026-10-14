import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rowidShuffleParams } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Faceted tags (§5b).
 *
 * The behaviour worth pinning down is not "a tag can be attached to an item" — it is the
 * two properties that make the library safe to automate against. Re-running a stage must
 * replace only its own assignments, so that re-parsing filenames is something a person will
 * actually dare to run; and selecting two values must narrow rather than widen, because a
 * filter that grows as you add constraints reads as broken.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagRepo = await import("./tagRepo.js");
const { db: sharedDb } = await import("../db.js");

const MEDIA_A = "11111111-0000-4000-8000-000000000000";
const MEDIA_B = "22222222-0000-4000-8000-000000000000";
const USER = "99999999-0000-4000-8000-000000000000";
const OTHER_USER = "88888888-0000-4000-8000-000000000000";
/** The library every fixture item is in, and the one viewer the counts are asked for. */
const ROOT = "root-a";
const VIEWER = { userId: USER, rootIds: [ROOT] };

/**
 * An item the library would actually show.
 *
 * `listable` is set here rather than left to the triggers, because the counts these tests
 * assert now join it: a tag's "items" number has to match what clicking it returns, and a
 * fixture that is invisible to the grid would count towards a number the grid cannot produce.
 */
const addMedia = (id: string): void => {
    sharedDb
        .prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
             VALUES (?, 'video', 'Test', 1, ?, CURRENT_TIMESTAMP)`
        )
        .run(id, ROOT);
};

const addUser = (id: string, name: string): void => {
    sharedDb
        .prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES (?, ?, ?, 'x', CURRENT_TIMESTAMP)`
        )
        .run(id, `${name}@example.test`, name);
};

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

    addMedia(MEDIA_A);
    addMedia(MEDIA_B);
    addUser(USER, "user");
    addUser(OTHER_USER, "other");
});

describe("ensureTag", () => {
    it("returns the same id for names that normalise alike", () => {
        const first = tagRepo.ensureTag("performer", "Jane Doe", null);
        const second = tagRepo.ensureTag("performer", "  jane   DOE ", null);

        expect(second).toBe(first);
    });

    it("keeps the display name the first writer chose", () => {
        // Otherwise tagging something "JANE DOE" silently rewrites the name everyone sees.
        tagRepo.ensureTag("performer", "Jane Doe", null);
        tagRepo.ensureTag("performer", "JANE DOE", null);

        expect(tagRepo.resolveName("performer", "jane doe", null)?.tag.name).toBe("Jane Doe");
    });

    it("keeps the same name in different facets apart", () => {
        // A studio and a series can legitimately share a name, and collapsing them would
        // make filtering by one silently include the other.
        const studio = tagRepo.ensureTag("studio", "Aurora", null);
        const series = tagRepo.ensureTag("series", "Aurora", null);

        expect(studio).not.toBe(series);
    });

    it("refuses a name with nothing to normalise", () => {
        // "???" normalises to empty, which would violate the NOT NULL check with a far less
        // comprehensible error, and would create a tag nobody could ever search for.
        expect(() => tagRepo.ensureTag("performer", "???", null)).toThrow();
    });
});

describe("replaceFacet", () => {
    it("replaces only the named facet", () => {
        const performer = tagRepo.ensureTag("performer", "Jane Doe", null);
        const genre = tagRepo.ensureTag("genre", "Drama", null);

        tagRepo.replaceFacet(MEDIA_A, "performer", [performer], {
            userId: null,
            createdById: USER,
        });
        tagRepo.replaceFacet(MEDIA_A, "genre", [genre], { userId: null, createdById: USER });
        tagRepo.replaceFacet(MEDIA_A, "performer", [], { userId: null, createdById: USER });

        const kinds = tagRepo.listForMedia(MEDIA_A, USER).map((tag) => tag.kind);

        expect(kinds).toEqual(["genre"]);
    });

    it("replaces only assignments from the same source", () => {
        // This is what makes re-running filename parsing safe. Without it, a re-parse wipes
        // out everything a person typed, and so nobody ever runs it.
        const typed = tagRepo.ensureTag("performer", "Typed By Hand", null);
        const parsed = tagRepo.ensureTag("performer", "From Filename", null);

        tagRepo.assign({
            mediaId: MEDIA_A,
            tagId: typed,
            userId: null,
            createdById: USER,
            source: "user",
        });
        tagRepo.replaceFacet(MEDIA_A, "performer", [parsed], {
            userId: null,
            createdById: USER,
            source: "filename",
        });

        const names = tagRepo
            .listForMedia(MEDIA_A, USER)
            .map((tag) => tag.name)
            .sort();

        expect(names).toEqual(["From Filename", "Typed By Hand"]);
    });

    it("records the submitted order as position", () => {
        const first = tagRepo.ensureTag("performer", "First Billed", null);
        const second = tagRepo.ensureTag("performer", "Second Billed", null);

        tagRepo.replaceFacet(MEDIA_A, "performer", [first, second], {
            userId: null,
            createdById: USER,
        });

        expect(tagRepo.listForMedia(MEDIA_A, USER).map((tag) => tag.name)).toEqual([
            "First Billed",
            "Second Billed",
        ]);
    });
});

/**
 * Taking the last use of a tag away deletes the tag.
 *
 * A typo applied and then removed would otherwise stay in every suggestion list until somebody
 * cleaned it up on the Tags page. The interesting half is what must *survive*: a tag still in
 * use somewhere, one kept through a replace, and one coined on purpose that has no items yet.
 */
describe("removing the last use of a tag", () => {
    const exists = (tagId: string): boolean => tagRepo.findById(tagId) !== undefined;

    it("deletes the tag when the last item is untagged", () => {
        const typo = tagRepo.ensureTag("tag", "beahc", null);
        tagRepo.assign({ mediaId: MEDIA_A, tagId: typo, userId: null, createdById: USER });

        tagRepo.unassign(MEDIA_A, typo, null);

        expect(exists(typo)).toBe(false);
    });

    it("keeps the tag while another item still carries it", () => {
        const beach = tagRepo.ensureTag("tag", "beach", null);
        tagRepo.assign({ mediaId: MEDIA_A, tagId: beach, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_B, tagId: beach, userId: null, createdById: USER });

        tagRepo.unassign(MEDIA_A, beach, null);

        expect(exists(beach)).toBe(true);
    });

    it("deletes a tag a replace dropped, and keeps one it kept", () => {
        const kept = tagRepo.ensureTag("performer", "Jane Doe", null);
        const typo = tagRepo.ensureTag("performer", "Jnae Doe", null);
        const options = { userId: null, createdById: USER };

        tagRepo.replaceFacet(MEDIA_A, "performer", [kept, typo], options);
        tagRepo.replaceFacet(MEDIA_A, "performer", [kept], options);

        expect(exists(kept)).toBe(true);
        expect(exists(typo)).toBe(false);
    });

    it("keeps a tag that has aliases", () => {
        const tag = tagRepo.ensureTag("performer", "Jane Smith", null);
        tagRepo.setAliases(tag, ["Jane Doe"], USER);
        tagRepo.assign({ mediaId: MEDIA_A, tagId: tag, userId: null, createdById: USER });

        tagRepo.unassign(MEDIA_A, tag, null);

        expect(exists(tag)).toBe(true);
    });

    it("leaves alone a tag that was never applied", () => {
        // Coined on the Tags page, ahead of use. Nothing was taken from it, so it is not a
        // candidate — even though another tag's removal is what triggered the check.
        const coined = tagRepo.ensureTag("tag", "someday", null);
        const typo = tagRepo.ensureTag("tag", "beahc", null);
        tagRepo.assign({ mediaId: MEDIA_A, tagId: typo, userId: null, createdById: USER });

        tagRepo.unassign(MEDIA_A, typo, null);

        expect(exists(coined)).toBe(true);
    });
});

describe("listForMedia", () => {
    it("shows public tags and the viewer's own, but not another user's", () => {
        const shared = tagRepo.ensureTag("genre", "Drama", null);
        const mine = tagRepo.ensureTag("tag", "Mine", USER);
        const theirs = tagRepo.ensureTag("tag", "Theirs", OTHER_USER);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: shared, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_A, tagId: mine, userId: USER, createdById: USER });
        tagRepo.assign({
            mediaId: MEDIA_A,
            tagId: theirs,
            userId: OTHER_USER,
            createdById: OTHER_USER,
        });

        const names = tagRepo
            .listForMedia(MEDIA_A, USER)
            .map((tag) => tag.name)
            .sort();

        expect(names).toEqual(["Drama", "Mine"]);
    });

    /**
     * Privacy is a property of the tag now, not of each assignment of it (§6). The flag used
     * to be computed by counting -- private only if *no* library-wide assignment stood behind
     * it -- because a public tag could be carried both ways at once. It cannot any more.
     */
    it("reports privacy from the tag rather than from the assignment", () => {
        const shared = tagRepo.ensureTag("genre", "Drama", null);
        const mine = tagRepo.ensureTag("tag", "Mine", USER);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: shared, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_A, tagId: mine, userId: USER, createdById: USER });

        const byName = new Map(tagRepo.listForMedia(MEDIA_A, USER).map((t) => [t.name, t]));

        expect(byName.get("Drama")?.private).toBeNull();
        expect(byName.get("Mine")?.private).toBe(1);
    });

    /** Who applied it, which is the only record a public tag has of where it came from. */
    it("names whoever applied the tag", () => {
        const shared = tagRepo.ensureTag("genre", "Drama", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: shared, userId: null, createdById: USER });

        expect(tagRepo.listForMedia(MEDIA_A, USER)[0].addedBy).toBe("user");
    });
});

describe("the two systems do not cross", () => {
    /**
     * The invariant `init.ts` used to assert only in prose. Both directions are refused: a
     * private tag assigned publicly publishes a name its owner kept, and a public tag assigned
     * privately gives a shared chip a second, invisible meaning.
     */
    it("refuses a private tag assigned to anybody but its owner", () => {
        const mine = tagRepo.ensureTag("tag", "Mine", USER);

        expect(() =>
            tagRepo.assign({ mediaId: MEDIA_A, tagId: mine, userId: null, createdById: USER })
        ).toThrow(/cannot be assigned/);

        expect(() =>
            tagRepo.assign({
                mediaId: MEDIA_A,
                tagId: mine,
                userId: OTHER_USER,
                createdById: OTHER_USER,
            })
        ).toThrow(/cannot be assigned/);
    });

    it("refuses a public tag assigned privately", () => {
        const shared = tagRepo.ensureTag("genre", "Drama", null);

        expect(() =>
            tagRepo.assign({ mediaId: MEDIA_A, tagId: shared, userId: USER, createdById: USER })
        ).toThrow(/cannot be assigned privately/);
    });
});

describe("assign", () => {
    it("is a no-op when the tag is already there", () => {
        const tag = tagRepo.ensureTag("genre", "Drama", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: tag, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_A, tagId: tag, userId: null, createdById: USER });

        expect(tagRepo.listForMedia(MEDIA_A, USER)).toHaveLength(1);
    });
});

describe("mergeTags", () => {
    it("keeps the assignments of the tag being folded in", () => {
        // The reason to merge at all is the same performer arriving under two spellings, so
        // losing the assignments would defeat the purpose.
        const source = tagRepo.ensureTag("performer", "Jane Doe", null);
        const target = tagRepo.ensureTag("performer", "Jane D", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: source, userId: null, createdById: USER });
        tagRepo.mergeTags(source, target);

        expect(tagRepo.listForMedia(MEDIA_A, USER).map((tag) => tag.tagId)).toEqual([target]);
        expect(tagRepo.findById(source)).toBeUndefined();
    });

    it("survives an item that already carries both tags", () => {
        // The unique index would otherwise abort the merge partway through — on exactly the
        // duplicates that motivated the merge.
        const source = tagRepo.ensureTag("performer", "Jane Doe", null);
        const target = tagRepo.ensureTag("performer", "Jane D", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: source, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_A, tagId: target, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_B, tagId: source, userId: null, createdById: USER });

        expect(() => tagRepo.mergeTags(source, target)).not.toThrow();

        expect(tagRepo.listForMedia(MEDIA_A, USER).map((tag) => tag.tagId)).toEqual([target]);
        expect(tagRepo.listForMedia(MEDIA_B, USER).map((tag) => tag.tagId)).toEqual([target]);
    });
});

describe("listByKind", () => {
    it("includes a tag nothing is tagged with", () => {
        // A freshly created tag that vanishes from the management list looks like the create
        // silently failed.
        tagRepo.ensureTag("genre", "Unused", null);

        expect(tagRepo.listByKind("genre", null).map((tag) => tag.name)).toEqual(["Unused"]);
    });

    it("counts library assignments and orders by them", () => {
        const popular = tagRepo.ensureTag("genre", "Popular", null);
        const rare = tagRepo.ensureTag("genre", "Rare", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: popular, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_B, tagId: popular, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_A, tagId: rare, userId: null, createdById: USER });

        expect(tagRepo.listByKind("genre", null)).toEqual([
            expect.objectContaining({ name: "Popular", mediaCount: 2 }),
            expect.objectContaining({ name: "Rare", mediaCount: 1 }),
        ]);
    });

    it("leaves out items the library would not show", () => {
        const tag = tagRepo.ensureTag("genre", "Mixed", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: tag, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_B, tagId: tag, userId: null, createdById: USER });
        sharedDb.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = ?`).run(MEDIA_B);

        expect(tagRepo.listByKind("genre", null)).toEqual([
            expect.objectContaining({ name: "Mixed", mediaCount: 1 }),
        ]);
    });

    /**
     * On a saturated disk a statement costs the pages it touches (§20). Testing `listable`
     * through the primary key read every assigned item's whole row -- over a thousand pages
     * for the performer list on the NAS -- where the partial index answers from itself.
     */
    it("tests listability from the index rather than from each item's row", () => {
        const plan = sharedDb
            .prepare(
                `EXPLAIN QUERY PLAN SELECT t."id", count(m."id")
                   FROM "Tag" t
                   LEFT JOIN "MediaTag" mt ON mt."tagId" = t."id"
                   LEFT JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
                  WHERE t."kind" = ? AND t."ownerId" IS ?
                  GROUP BY t."id"`
            )
            .all("performer", null) as { detail: string }[];

        expect(plan.map((row) => row.detail).join("\n")).toContain(
            "COVERING INDEX idx_Media_listable_id"
        );
    });
});

describe("listForSelection", () => {
    const SELECTION = [MEDIA_A, MEDIA_B];

    it("counts items rather than assignments", () => {
        // The same viewer can carry a library tag and their own copy of it on one item -- the
        // two partial uniques permit exactly that -- and counting the rows would report "on 2
        // of 1", a fraction nothing on screen could explain.
        const shared = tagRepo.ensureTag("tag", "Beach", null);
        const mine = tagRepo.ensureTag("tag", "Beach", USER);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: shared, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_A, tagId: mine, userId: USER, createdById: USER });

        expect(tagRepo.listForSelection([MEDIA_A], USER, 10)).toEqual([
            expect.objectContaining({ tagId: shared, count: 1, private: null }),
            expect.objectContaining({ tagId: mine, count: 1, private: 1 }),
        ]);
    });

    it("leaves another account's private tagging out", () => {
        const theirs = tagRepo.ensureTag("tag", "Theirs", OTHER_USER);

        tagRepo.assign({
            mediaId: MEDIA_A,
            tagId: theirs,
            userId: OTHER_USER,
            createdById: OTHER_USER,
        });

        expect(tagRepo.listForSelection(SELECTION, USER, 10)).toEqual([]);
    });

    it("orders by how much of the selection carries each, then by name", () => {
        const both = tagRepo.ensureTag("tag", "Both", null);
        const one = tagRepo.ensureTag("tag", "One", null);

        tagRepo.assign({ mediaId: MEDIA_A, tagId: both, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_B, tagId: both, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: MEDIA_B, tagId: one, userId: null, createdById: USER });

        expect(tagRepo.listForSelection(SELECTION, USER, 10)).toEqual([
            expect.objectContaining({ name: "Both", count: 2 }),
            expect.objectContaining({ name: "One", count: 1 }),
        ]);
    });

    it("truncates at the limit it is given", () => {
        for (const name of ["A", "B", "C"]) {
            const tagId = tagRepo.ensureTag("tag", name, null);

            tagRepo.assign({ mediaId: MEDIA_A, tagId, userId: null, createdById: USER });
        }

        expect(tagRepo.listForSelection(SELECTION, USER, 2)).toHaveLength(2);
    });

    it("answers an empty selection without a query", () => {
        expect(tagRepo.listForSelection([], USER, 10)).toEqual([]);
    });
});

describe("updateTag moving a facet", () => {
    /** The bug this covers: the column was never written, so the move silently did nothing. */
    it("moves the tag, and its assignments with it", () => {
        const tagId = tagRepo.ensureTag("tag", "Jane Doe", null);
        tagRepo.assign({ mediaId: MEDIA_A, tagId, userId: null, createdById: USER });

        tagRepo.updateTag(tagId, { kind: "performer" });

        expect(tagRepo.findById(tagId)?.kind).toBe("performer");
        expect(tagRepo.listForMedia(MEDIA_A, USER)).toEqual([
            expect.objectContaining({ tagId, kind: "performer" }),
        ]);
    });

    it("refuses to move a private tag to a facet that cannot be private", () => {
        const tagId = tagRepo.ensureTag("tag", "mine", USER, USER);

        expect(() => tagRepo.updateTag(tagId, { kind: "performer" })).toThrow(/only tags can/);
        expect(tagRepo.findById(tagId)?.kind).toBe("tag");
    });
});

describe("browsing a facet", () => {
    const PHOTO = "33333333-0000-4000-8000-000000000000";
    const TRASHED = "44444444-0000-4000-8000-000000000000";

    const tag = (tagId: string, mediaId: string, owner: string | null = null) =>
        tagRepo.assign({ mediaId, tagId, userId: owner, createdById: USER });

    const browse = (owner: string | null, options: Partial<tagRepo.BrowseOptions> = {}) =>
        tagRepo.browseTags(owner, {
            kind: "performer",
            sort: "count",
            viewerId: USER,
            rootIds: [ROOT],
            limit: 30,
            offset: 0,
            ...options,
        });

    beforeEach(() => {
        sharedDb
            .prepare(
                `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
                 VALUES (?, 'image', 'Photo', 1, ?, CURRENT_TIMESTAMP)`
            )
            .run(PHOTO, ROOT);
        // Carried by a tag but not something the grid shows, so nothing may count it.
        sharedDb
            .prepare(
                `INSERT INTO "Media" ("id", "kind", "title", "listable", "updatedAt")
                 VALUES (?, 'video', 'Gone', NULL, CURRENT_TIMESTAMP)`
            )
            .run(TRASHED);
    });

    it("counts videos and photos apart, and only listable ones", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);

        tag(dad, MEDIA_A);
        tag(dad, PHOTO);
        tag(dad, TRASHED);

        expect(browse(null).rows).toEqual([
            expect.objectContaining({ name: "Dad", videoCount: 1, imageCount: 1 }),
        ]);
    });

    it("leaves out tags nothing visible carries", () => {
        const unused = tagRepo.ensureTag("performer", "Nobody", null);
        const gone = tagRepo.ensureTag("performer", "Only trashed", null);

        tag(gone, TRASHED);

        expect(unused).toBeTruthy();
        expect(browse(null)).toEqual({ rows: [], total: 0 });
    });

    it("orders by items, by name, or by most recently tagged", () => {
        const many = tagRepo.ensureTag("performer", "Zed", null);
        const few = tagRepo.ensureTag("performer", "Amy", null);

        tag(many, MEDIA_A);
        tag(many, MEDIA_B);
        tag(few, MEDIA_A);
        sharedDb
            .prepare(`UPDATE "MediaTag" SET "createdAt" = '2020-01-01' WHERE "tagId" = ?`)
            .run(many);

        const names = (sort: tagRepo.BrowseSort) =>
            browse(null, { sort }).rows.map((row) => row.name);

        expect(names("count")).toEqual(["Zed", "Amy"]);
        expect(names("name")).toEqual(["Amy", "Zed"]);
        expect(names("recent")).toEqual(["Amy", "Zed"]);
    });

    it("orders by videos, with photos only breaking a tie", () => {
        const photos = tagRepo.ensureTag("performer", "Amy", null);
        const video = tagRepo.ensureTag("performer", "Zed", null);
        const both = tagRepo.ensureTag("performer", "Bea", null);

        tag(photos, PHOTO);
        tag(photos, MEDIA_A);
        tag(video, MEDIA_A);
        tag(video, MEDIA_B);
        tag(both, MEDIA_B);

        // Amy has two items but one video; Zed two videos; Bea one video and no photo.
        expect(browse(null).rows.map((row) => row.name)).toEqual(["Zed", "Amy", "Bea"]);
    });

    it("finds a tag by one of its aliases", () => {
        const mum = tagRepo.ensureTag("performer", "Mum", null);

        tag(mum, MEDIA_A);
        tagRepo.setAliases(mum, ["Mom"], USER);

        expect(browse(null, { search: "mo" }).rows.map((row) => row.name)).toEqual(["Mum"]);
    });

    it("pages, with a total of the whole facet", () => {
        for (const name of ["A", "B", "C"]) {
            tag(tagRepo.ensureTag("performer", name, null), MEDIA_A);
        }

        const page = browse(null, { sort: "name", limit: 2, offset: 2 });

        expect(page.rows.map((row) => row.name)).toEqual(["C"]);
        expect(page.total).toBe(3);
    });

    it("shows one person's private tags to them alone", () => {
        const mine = tagRepo.ensureTag("tag", "beach", USER);

        tag(mine, MEDIA_A, USER);

        expect(browse(USER, { kind: "tag" }).rows.map((row) => row.name)).toEqual(["beach"]);
        expect(browse(OTHER_USER, { kind: "tag" }).rows).toEqual([]);
        expect(browse(null, { kind: "tag" }).rows).toEqual([]);
    });

    it("counts one tag's videos and photos apart, and only listable ones", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);

        expect(tagRepo.countByKind(dad, VIEWER)).toEqual({ videoCount: 0, imageCount: 0 });

        tag(dad, MEDIA_A);
        tag(dad, PHOTO);
        tag(dad, TRASHED);

        expect(tagRepo.countByKind(dad, VIEWER)).toEqual({ videoCount: 1, imageCount: 1 });
    });

    /**
     * Each of these numbers opens a grid, and the grid shows only the viewer's libraries and
     * leaves out what they hid -- so the number has to as well, or it promises items the click
     * cannot produce.
     */
    it("counts only what the viewer's grid would show", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);

        tag(dad, MEDIA_A);
        tag(dad, MEDIA_B);
        tag(dad, PHOTO);

        sharedDb
            .prepare(
                `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
                 VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
            )
            .run(USER, MEDIA_A);
        sharedDb.prepare(`UPDATE "Media" SET "listRootId" = 'elsewhere' WHERE "id" = ?`).run(PHOTO);

        expect(tagRepo.countByKind(dad, VIEWER)).toEqual({ videoCount: 1, imageCount: 0 });
        expect(browse(null).rows).toEqual([
            expect.objectContaining({ name: "Dad", videoCount: 1, imageCount: 0 }),
        ]);

        // Somebody else's hiding is theirs; another library is somebody else's to reach.
        expect(tagRepo.countByKind(dad, { userId: OTHER_USER, rootIds: [ROOT] })).toEqual({
            videoCount: 2,
            imageCount: 0,
        });
        expect(
            tagRepo.countByKind(dad, { userId: OTHER_USER, rootIds: [ROOT, "elsewhere"] })
        ).toEqual({ videoCount: 2, imageCount: 1 });

        // No libraries at all: nothing to count, and nothing on the browse page.
        expect(tagRepo.countByKind(dad, { userId: USER, rootIds: [] })).toEqual({
            videoCount: 0,
            imageCount: 0,
        });
        expect(browse(null, { rootIds: [] })).toEqual({ rows: [], total: 0 });
    });

    /**
     * A count split by kind reads `m."kind"`, and one narrowed to the viewer reads
     * `m."listRootId"`; on a saturated disk a statement costs the pages it touches (§20).
     * Through the primary key, or through `idx_Media_listable_id`, each assignment fetches its
     * item's whole row for those two words -- ~990 pages for a page of performers against ~220
     * from the index. So this explains the statements the repo actually runs, in every shape
     * the Tags page and a tag's own page can ask for.
     */
    it("reads kind and root from the index rather than from each item's row", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);

        tag(dad, MEDIA_A);
        tag(dad, PHOTO);

        const prepare = vi.spyOn(sharedDb, "prepare");
        let prepared: string[];

        try {
            for (const sort of ["count", "name", "recent"] as const) {
                browse(null, { sort });
            }
            browse(USER, { kind: "tag", favorite: true });
            browse(null, { search: "da" });
            tagRepo.countByKind(dad, VIEWER);
            tagRepo.companions(dad, "performer", 16, VIEWER);
            tagRepo.sampleSharedMediaIds(dad, [dad], rowidShuffleParams(1), 6, VIEWER);
        } finally {
            // Restoring clears the recorded calls, so they are taken first.
            prepared = prepare.mock.calls.map(([sql]) => sql);
            prepare.mockRestore();
        }

        const statements = prepared.filter((sql) => sql.includes(`JOIN "Media" m`));

        // Three sorts, favourites and a search -- a page and a total each -- countByKind, and
        // the two "Appears with" statements.
        expect(statements).toHaveLength(13);

        for (const sql of statements) {
            // The plan does not depend on the values, only on every parameter being bound.
            const named = Object.fromEntries(
                [...sql.matchAll(/:(\w+)/g)].map(([, name]) => [name, null])
            );
            const positional = Array.from({ length: sql.split("?").length - 1 }, () => null);
            const explain = sharedDb.prepare(`EXPLAIN QUERY PLAN ${sql}`);
            const rows = (
                positional.length > 0 ? explain.all(...positional) : explain.all(named)
            ) as { detail: string }[];
            const plan = rows.map((row) => row.detail).join("\n");

            // The name and the space after it: `idx_Media_listable_id_kind` is a prefix of the
            // index wanted here, and lacks the root the viewer's libraries are checked against.
            expect(plan).toContain(
                "SEARCH m USING COVERING INDEX idx_Media_listable_id_kind_root "
            );
            expect(plan).toContain("SEARCH um USING INDEX idx_UserMedia_hidden ");
        }
    });
});

describe("sampleMediaIdsByTag", () => {
    const ids = Array.from(
        { length: 12 },
        (_, i) => `${String(i).padStart(8, "0")}-1111-4000-8000-000000000000`
    );

    const shuffle = (seed: number) => rowidShuffleParams(seed);

    beforeEach(() => {
        for (const id of ids) addMedia(id);
    });

    it("gives the same sample for the same seed, and caps it per tag", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);
        const mum = tagRepo.ensureTag("performer", "Mum", null);

        for (const id of ids) {
            tagRepo.assign({ mediaId: id, tagId: dad, userId: null, createdById: USER });
        }
        tagRepo.assign({ mediaId: ids[0], tagId: mum, userId: null, createdById: USER });

        const first = tagRepo.sampleMediaIdsByTag([dad, mum], null, shuffle(7), 4);

        expect(first.get(dad)).toHaveLength(4);
        expect(first.get(mum)).toEqual([ids[0]]);
        expect(tagRepo.sampleMediaIdsByTag([dad, mum], null, shuffle(7), 4)).toEqual(first);
    });

    it("changes with the seed", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);

        for (const id of ids) {
            tagRepo.assign({ mediaId: id, tagId: dad, userId: null, createdById: USER });
        }

        const samples = new Set(
            [1, 2, 3, 4, 5].map((seed) =>
                JSON.stringify(tagRepo.sampleMediaIdsByTag([dad], null, shuffle(seed), 4).get(dad))
            )
        );

        expect(samples.size).toBeGreaterThan(1);
    });

    it("skips items the library would not show", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);

        tagRepo.assign({ mediaId: ids[0], tagId: dad, userId: null, createdById: USER });
        tagRepo.assign({ mediaId: ids[1], tagId: dad, userId: null, createdById: USER });
        sharedDb.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = ?`).run(ids[1]);

        expect(tagRepo.sampleMediaIdsByTag([dad], null, shuffle(1), 6).get(dad)).toEqual([ids[0]]);
    });

    /** Videos unless you ask (§14e): a strip is the videos, or the photos of a tag with none. */
    it("draws only videos for a tag that has any, and photos for one that has none", () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);
        const mum = tagRepo.ensureTag("performer", "Mum", null);
        const photos = new Set(ids.slice(2));

        sharedDb
            .prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" NOT IN (?, ?)`)
            .run(ids[0], ids[1]);
        for (const id of ids) {
            tagRepo.assign({ mediaId: id, tagId: dad, userId: null, createdById: USER });
        }
        for (const id of photos) {
            tagRepo.assign({ mediaId: id, tagId: mum, userId: null, createdById: USER });
        }

        const sample = tagRepo.sampleMediaIdsByTag([dad, mum], null, shuffle(3), 6);

        expect([...(sample.get(dad) ?? [])].sort()).toEqual([ids[0], ids[1]]);
        expect(sample.get(mum)).toHaveLength(6);
        expect(sample.get(mum)?.every((id) => photos.has(id))).toBe(true);
    });
});

describe("companions", () => {
    const viewer = VIEWER;

    /** Dad and Mum on both items, Kid on one. */
    const family = () => {
        const dad = tagRepo.ensureTag("performer", "Dad", null);
        const mum = tagRepo.ensureTag("performer", "Mum", null);
        const kid = tagRepo.ensureTag("performer", "Kid", null);
        const place = tagRepo.ensureTag("tag", "beach", null);

        for (const [media, tagId] of [
            [MEDIA_A, dad],
            [MEDIA_B, dad],
            [MEDIA_A, mum],
            [MEDIA_B, mum],
            [MEDIA_A, kid],
            [MEDIA_A, place],
        ] as const) {
            tagRepo.assign({ mediaId: media, tagId, userId: null, createdById: USER });
        }

        return { dad, mum, kid };
    };

    it("names the library's performers sharing items, most shared first", () => {
        const { dad, mum, kid } = family();

        expect(tagRepo.companions(dad, "performer", 10, viewer)).toEqual([
            { tagId: mum, name: "Mum", shared: 2 },
            { tagId: kid, name: "Kid", shared: 1 },
        ]);
    });

    it("counts only what the viewer's grid would show", () => {
        const { dad, mum } = family();

        // MEDIA_A hidden by this viewer, MEDIA_B in a library they cannot reach.
        sharedDb
            .prepare(
                `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
                 VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
            )
            .run(USER, MEDIA_A);

        expect(tagRepo.companions(dad, "performer", 10, viewer)).toEqual([
            { tagId: mum, name: "Mum", shared: 1 },
        ]);

        sharedDb
            .prepare(`UPDATE "Media" SET "listRootId" = 'elsewhere' WHERE "id" = ?`)
            .run(MEDIA_B);

        expect(tagRepo.companions(dad, "performer", 10, viewer)).toEqual([]);
        // Somebody else's hiding is theirs.
        expect(
            tagRepo.companions(dad, "performer", 10, { userId: OTHER_USER, rootIds: [ROOT] })
        ).toHaveLength(2);
        expect(tagRepo.companions(dad, "performer", 10, { userId: USER, rootIds: [] })).toEqual([]);
    });

    it("samples only the items both carry that the viewer can see", () => {
        const { dad, mum, kid } = family();

        sharedDb
            .prepare(`UPDATE "Media" SET "listRootId" = 'elsewhere' WHERE "id" = ?`)
            .run(MEDIA_B);

        const sampled = tagRepo.sampleSharedMediaIds(
            dad,
            [mum, kid],
            rowidShuffleParams(1),
            6,
            viewer
        );

        expect(sampled.get(mum)).toEqual([MEDIA_A]);
        expect(sampled.get(kid)).toEqual([MEDIA_A]);
        expect(tagRepo.sampleSharedMediaIds(dad, [], rowidShuffleParams(1), 6, viewer).size).toBe(
            0
        );
    });
});

/** §5b "One rule for names": the tag box searches the whole facet, by the server's rule. */
describe("searchByKind", () => {
    const names = (search: string): { names: string[]; near: boolean } => {
        const { rows, near } = tagRepo.searchByKind("performer", null, search, 50);

        return { names: rows.map((row) => row.name).sort(), near };
    };

    it("finds a name however it is typed — accents, separators, glued", () => {
        tagRepo.ensureTag("performer", "Zoë Laine", null);
        tagRepo.ensureTag("performer", "Mary-Kate", null);

        expect(names("zoe").names).toEqual(["Zoë Laine"]);
        expect(names("laine").names).toEqual(["Zoë Laine"]);
        expect(names("mary kate").names).toEqual(["Mary-Kate"]);
        expect(names("marykate").names).toEqual(["Mary-Kate"]);
    });

    it("reaches every name, not only the most used ones", () => {
        for (let n = 0; n < 600; n += 1) {
            tagRepo.ensureTag("performer", `Common ${n}`, null);
        }
        tagRepo.ensureTag("performer", "Rarely Seen", null);

        expect(names("rarely").names).toEqual(["Rarely Seen"]);
    });

    it("says when it answered with close spellings because nothing matched", () => {
        tagRepo.ensureTag("performer", "Aunt Margaret", null);

        expect(names("margaret")).toEqual({ names: ["Aunt Margaret"], near: false });
        expect(names("margret")).toEqual({ names: ["Aunt Margaret"], near: true });
    });

    it("searches only the system it is asked about", () => {
        tagRepo.ensureTag("performer", "Jane Doe", null);

        expect(tagRepo.searchByKind("performer", "someone-else", "jane", 50).rows).toEqual([]);
    });
});
