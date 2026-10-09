import {
    SEARCH_COLUMN_WEIGHTS,
    buildMatchExpression,
    expandCompounds,
    searchVariants,
} from "@private-stock/core";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The search index, against real FTS5.
 *
 * Two things here cannot be tested any other way. The first is that every expression the
 * query builder can emit actually *parses* — FTS5 raises on a malformed query rather than
 * returning nothing, so a search box that accepts arbitrary typing has to be proven safe
 * against a real parser, not against a regex someone believed in.
 *
 * The second is deletion. The index is external-content and kept in step by triggers, and
 * the path that matters most — a Media row going away and taking its index entry with it —
 * runs through a foreign-key cascade. Whether a cascade fires a trigger is exactly the kind
 * of thing that is easy to assume and wrong.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const searchRepo = await import("./searchRepo.js");
const { db: sharedDb } = await import("../db.js");

const MEDIA_A = "11111111-0000-4000-8000-000000000000";
const MEDIA_B = "22222222-0000-4000-8000-000000000000";

const addMedia = (id: string, title: string): void => {
    sharedDb
        .prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
             VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
        )
        .run(id, title);
};

const emptyDoc = (mediaId: string): searchRepo.SearchDocument => ({
    mediaId,
    filename: "",
    title: "",
    performers: "",
    tags: "",
    attributes: "",
    notes: "",
    ocr: "",
    variants: "",
});

/**
 * Ids matching an expression, best first.
 *
 * Ranked with the shipped column weights rather than FTS5's bare `rank`, which is bm25 with
 * every column weighted 1. Using `rank` here would make the ranking assertions pass or fail
 * for reasons unrelated to the weights the app actually queries with — that is, it would
 * test nothing.
 */
const matching = (raw: string): string[] => {
    const expression = buildMatchExpression(raw);

    if (!expression) {
        return [];
    }

    return (
        db
            .prepare(
                `SELECT "mediaId" FROM "MediaSearch"
                  WHERE "MediaSearch" MATCH ?
                  ORDER BY bm25("MediaSearch", ${SEARCH_COLUMN_WEIGHTS.join(", ")})`
            )
            .all(expression) as { mediaId: string }[]
    ).map((row) => row.mediaId);
};

const indexEntryCount = (): number =>
    (db.prepare(`SELECT count(*) AS n FROM "MediaSearch"`).get() as { n: number }).n;

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    // Virtual tables own several real tables apiece, and those cannot be dropped directly —
    // SQLite rejects the name as reserved. Dropping the virtual table takes them with it, so
    // they are skipped here rather than enumerated.
    const virtualTables = (
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
    ).filter((row) => !virtualTables.some((prefix) => row.name.startsWith(prefix)));

    for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    addMedia(MEDIA_A, "Summer Rain");
    addMedia(MEDIA_B, "Winter Sun");
});

describe("upsertDocument", () => {
    it("makes an item findable", () => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Summer Rain" });

        expect(matching("summer")).toEqual([MEDIA_A]);
    });

    it("replaces the old entry rather than adding a second one", () => {
        // Re-indexing has to be idempotent: the index stage re-runs over the whole library
        // whenever the recipe changes, and a second set of entries would make an item match
        // its own former contents forever.
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Summer Rain" });
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Autumn Rain" });

        expect(indexEntryCount()).toBe(1);
        expect(matching("summer")).toEqual([]);
        expect(matching("autumn")).toEqual([MEDIA_A]);
    });

    it("finds a word by its stem", () => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), notes: "a performance in the rain" });

        expect(matching("performing")).toEqual([MEDIA_A]);
    });

    it("finds an accented name typed without accents", () => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), performers: "Chloé Durand" });

        expect(matching("chloe")).toEqual([MEDIA_A]);
    });

    it("matches a prefix while the word is still being typed", () => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Wombat" });

        expect(matching("wom")).toEqual([MEDIA_A]);
    });

    it("ranks a title hit above the same word in scraped attributes", () => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_B), attributes: "harbour" });
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Harbour" });

        // Weighting is the whole reason the document has columns rather than being one blob.
        expect(matching("harbour")).toEqual([MEDIA_A, MEDIA_B]);
    });

    it("excludes a -term", () => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "rain", tags: "summer" });
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_B), title: "rain", tags: "winter" });

        expect(matching("rain -winter")).toEqual([MEDIA_A]);
    });
});

describe("expressions that would otherwise be FTS5 syntax", () => {
    /**
     * Every one of these is a syntax error, or silently means something else, if the raw
     * text reaches MATCH. On a library of scene files, punctuation in the search box is the
     * normal case — so the requirement is that none of them throws, whatever they return.
     */
    const hostile = [
        "AND",
        "OR",
        "NOT",
        "NEAR",
        "*",
        '"',
        'unbalanced "quote',
        "(",
        ")",
        "^",
        "-",
        "- -",
        "a:b",
        "c:/videos/file.mp4",
        "100% real",
        "50/50",
        "f**k",
        "NEAR(a b, 2)",
        "  ",
        "'; DROP TABLE Media; --",
    ];

    it.each(hostile)("survives %j", (input) => {
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Summer Rain" });

        expect(() => matching(input)).not.toThrow();
        // The injection attempt in particular must leave the library intact.
        expect((db.prepare(`SELECT count(*) AS n FROM "Media"`).get() as { n: number }).n).toBe(2);
    });
});

describe("staying in step with the library", () => {
    it("drops the index entry when the media row is deleted", () => {
        // The cascade runs Media -> MediaSearchDoc, and the doc's delete trigger is what
        // removes the index entry. If a cascade did not fire triggers, this would leave an
        // orphaned entry that still matched searches for an item that no longer exists.
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Summer Rain" });
        expect(matching("summer")).toEqual([MEDIA_A]);

        db.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run(MEDIA_A);

        expect(matching("summer")).toEqual([]);
        expect(indexEntryCount()).toBe(0);
    });

    it("never reuses a rowid", () => {
        // FTS5 keeps its own copy of the rowid mapping. A recycled rowid would attach one
        // item's index entries to another item's document, which is why the doc table
        // declares AUTOINCREMENT rather than relying on the default.
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_A), title: "Summer Rain" });
        const first = db
            .prepare(`SELECT "rowid" FROM "MediaSearchDoc" WHERE "mediaId" = ?`)
            .get(MEDIA_A) as { rowid: number };

        db.prepare(`DELETE FROM "MediaSearchDoc" WHERE "mediaId" = ?`).run(MEDIA_A);
        searchRepo.upsertDocument({ ...emptyDoc(MEDIA_B), title: "Winter Sun" });

        const second = db
            .prepare(`SELECT "rowid" FROM "MediaSearchDoc" WHERE "mediaId" = ?`)
            .get(MEDIA_B) as { rowid: number };

        expect(second.rowid).toBeGreaterThan(first.rowid);
    });
});

describe("text read out of the picture", () => {
    it("finds an item by a word that only exists in its picture", () => {
        addMedia("m1", "Untitled");
        searchRepo.upsertDocument({ ...emptyDoc("m1"), ocr: "example-site.com" });

        // The point of the whole feature: the filename is noise, there is no sidecar, and the
        // watermark is the only thing that says where this came from.
        expect(matching("example-site.com")).toEqual(["m1"]);
    });

    it("loses to the item actually titled that", () => {
        addMedia("m1", "Untitled");
        addMedia("m2", "Aurora");
        searchRepo.upsertDocument({ ...emptyDoc("m1"), ocr: "AURORA" });
        searchRepo.upsertDocument({ ...emptyDoc("m2"), title: "Aurora" });

        // Recognition can elect a wrong reading, so a hit here is weaker evidence than a
        // curated field -- and a machine-read term that outranked a title would not merely
        // fail to help, it would push the right answer down.
        expect(matching("aurora")).toEqual(["m2", "m1"]);
    });

    it("beats a passing mention in a scraped blurb", () => {
        addMedia("m1", "Untitled");
        addMedia("m2", "Untitled");
        searchRepo.upsertDocument({ ...emptyDoc("m1"), ocr: "AURORA" });
        searchRepo.upsertDocument({
            ...emptyDoc("m2"),
            attributes: "description Filmed near Aurora one winter",
        });

        // A watermark is about the item; a blurb mentions many things in passing.
        expect(matching("aurora")).toEqual(["m1", "m2"]);
    });

    it("has a weight for every column it indexes", () => {
        // bm25() takes weights positionally, so a column added without one silently shifts
        // every weight onto the wrong column rather than failing -- and the core package
        // cannot check this, because the schema is here.
        const columns = db.prepare(`PRAGMA table_info("MediaSearch")`).all() as { name: string }[];

        expect(SEARCH_COLUMN_WEIGHTS).toHaveLength(columns.length);
        expect(columns.at(-1)?.name).toBe("variants");
    });
});

/**
 * §5c "Word boundaries", end to end: a document written the way the index stage writes it, and
 * every spelling of one name that somebody might type.
 */
describe("word boundaries", () => {
    const indexFilename = (mediaId: string, filename: string): void => {
        searchRepo.upsertDocument({
            ...emptyDoc(mediaId),
            filename: expandCompounds(filename),
            variants: searchVariants({ phrases: [filename], messy: [] }, new Map()),
        });
    };

    const spellings = [
        "Aunt Margaret",
        "aunt margaret",
        "auntmargaret",
        "aunt.margaret",
        "aunt+margaret",
        "AuntMargaret",
    ];

    it.each(["Aunt Margaret", "aunt margaret", "AuntMargaret", "auntmargaret", "aunt_margaret"])(
        "finds a file named %j by every spelling",
        (written) => {
            indexFilename(MEDIA_A, written.replace("_", " "));

            for (const typed of spellings) {
                expect(matching(typed), `${typed} -> ${written}`).toEqual([MEDIA_A]);
            }
        }
    );

    it("finds a camelCase name by one of its words", () => {
        indexFilename(MEDIA_A, "AuntMargaret Beach");

        expect(matching("margaret")).toEqual([MEDIA_A]);
    });

    it("finds a glued name while it is still being typed", () => {
        indexFilename(MEDIA_A, "Aunt Margaret");

        expect(matching("auntmarg")).toEqual([MEDIA_A]);
        expect(matching("aunt marg")).toEqual([MEDIA_A]);
    });

    it("ranks the item written as typed above the one matched by another spelling", () => {
        indexFilename(MEDIA_A, "aunt margaret");
        indexFilename(MEDIA_B, "auntmargaret");

        expect(matching("auntmargaret")).toEqual([MEDIA_B, MEDIA_A]);
    });

    it("still excludes a -term across the alternatives", () => {
        indexFilename(MEDIA_A, "auntmargaret winter");
        indexFilename(MEDIA_B, "aunt margaret summer");

        expect(matching("aunt margaret -winter")).toEqual([MEDIA_B]);
    });
});
