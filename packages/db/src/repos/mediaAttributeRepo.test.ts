import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * What a file says about itself (§5b): the `metadata` stage owns its `embedded` rows and nothing
 * else, and the library-wide rematch reads the same text the index stage matches.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaAttributeRepo = await import("./mediaAttributeRepo.js");
const mentionRepo = await import("./mentionRepo.js");
const searchRepo = await import("./searchRepo.js");
const { db: sharedDb } = await import("../db.js");

const addAttribute = (key: string, value: string, source: string): void => {
    db.prepare(
        `INSERT INTO "MediaAttribute" ("id", "mediaId", "key", "value", "source")
         VALUES (?, 'm1', ?, ?, ?)`
    ).run(`${key}-${source}`, key, value, source);
};

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    // Not the FTS index's own shadow tables: they go with their virtual table.
    const virtualPrefixes = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "sql" LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

    for (const { name } of db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]) {
        if (!virtualPrefixes.some((prefix) => name.startsWith(prefix))) {
            db.exec(`DROP TABLE IF EXISTS "${name}"`);
        }
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES ('m1', 'video', 'm1', CURRENT_TIMESTAMP)`
    ).run();
});

describe("replaceEmbedded", () => {
    it("writes what the file says, and reports no change when it says the same again", () => {
        const found = new Map([
            ["title", "A title"],
            ["comment", "By @someone"],
        ]);

        expect(mediaAttributeRepo.replaceEmbedded("m1", found)).toBe(true);
        expect(mediaAttributeRepo.replaceEmbedded("m1", found)).toBe(false);
        expect(mediaAttributeRepo.listForMedia("m1")).toEqual([
            { key: "comment", value: "By @someone", source: "embedded" },
            { key: "title", value: "A title", source: "embedded" },
        ]);
    });

    it("replaces only its own rows, and leaves a key another source holds alone", () => {
        addAttribute("title", "Typed by somebody", "user");
        mediaAttributeRepo.replaceEmbedded("m1", new Map([["artist", "Old"]]));

        expect(
            mediaAttributeRepo.replaceEmbedded(
                "m1",
                new Map([
                    ["title", "The file's title"],
                    ["comment", "New"],
                ])
            )
        ).toBe(true);
        expect(mediaAttributeRepo.listForMedia("m1")).toEqual([
            { key: "comment", value: "New", source: "embedded" },
            { key: "title", value: "Typed by somebody", source: "user" },
        ]);

        // The file still claims the title, and that is not a change worth a reindex.
        expect(
            mediaAttributeRepo.replaceEmbedded(
                "m1",
                new Map([
                    ["title", "The file's title"],
                    ["comment", "New"],
                ])
            )
        ).toBe(false);
    });

    it("clears what a file no longer says", () => {
        mediaAttributeRepo.replaceEmbedded("m1", new Map([["title", "Gone soon"]]));

        expect(mediaAttributeRepo.replaceEmbedded("m1", new Map())).toBe(true);
        expect(mediaAttributeRepo.listForMedia("m1")).toEqual([]);
    });
});

describe("documentsAfter", () => {
    it("gives the rematch the values alone, in key order, as the index stage joins them", () => {
        searchRepo.upsertDocument({
            mediaId: "m1",
            filename: "",
            title: "",
            performers: "",
            tags: "",
            attributes: "title A title comment By @someone",
            notes: "",
            ocr: "",
            variants: "",
        });
        mediaAttributeRepo.replaceEmbedded(
            "m1",
            new Map([
                ["title", "A title"],
                ["comment", "By @someone"],
            ])
        );

        const joined = mediaAttributeRepo
            .listForMedia("m1")
            .map((row) => row.value)
            .join(" ");

        expect(mentionRepo.documentsAfter(0, 10)[0].texts.metadata).toBe(joined);
        expect(joined).toBe("By @someone A title");
    });
});
