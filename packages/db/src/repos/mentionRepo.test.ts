import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Which tags an item's own text names (§5b "One rule for names"). The matcher is core's; what
 * matters here is that the store writes only what changed and never references a tag that is gone.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mentionRepo = await import("./mentionRepo.js");
const { db: sharedDb } = await import("../db.js");

const addMedia = (id: string): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
    ).run(id, id);
};

const addTag = (id: string, name: string, ownerId: string | null = null): void => {
    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "ownerId", "updatedAt")
         VALUES (?, 'performer', ?, lower(?), ?, CURRENT_TIMESTAMP)`
    ).run(id, name, name, ownerId);
};

const rows = (): string[] =>
    (
        db
            .prepare(`SELECT "mediaId", "tagId", "field" FROM "MediaMention" ORDER BY 1, 2, 3`)
            .all() as {
            mediaId: string;
            tagId: string;
            field: string;
        }[]
    ).map((row) => `${row.mediaId}:${row.tagId}:${row.field}`);

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
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES ('someone', 'someone@example.com', 'Someone', 'x', CURRENT_TIMESTAMP)`
    ).run();
});

describe("mentionRepo", () => {
    it("matches every tag's names and aliases, private ones included", () => {
        addTag("pub", "Jane Doe");
        addTag("priv", "Aunt Margaret", null);
        db.prepare(`UPDATE "Tag" SET "ownerId" = 'someone' WHERE "id" = 'priv'`).run();
        db.prepare(
            `INSERT INTO "TagAlias" ("id", "tagId", "name", "nameNorm") VALUES ('a', 'pub', 'Janey', 'janey')`
        ).run();

        expect(mentionRepo.vocabulary()).toEqual([
            { tagId: "priv", name: "Aunt Margaret" },
            { tagId: "pub", name: "Jane Doe" },
            { tagId: "pub", name: "Janey" },
        ]);
    });

    it("writes only the items whose mentions changed, and replaces them whole", () => {
        addMedia("m1");
        addMedia("m2");
        addTag("t1", "One");
        addTag("t2", "Two");

        expect(
            mentionRepo.writeChanged([
                { mediaId: "m1", mentions: [{ tagId: "t1", field: "filename" }] },
                { mediaId: "m2", mentions: [] },
            ])
        ).toBe(1);
        expect(rows()).toEqual(["m1:t1:filename"]);

        // The same answer again writes nothing.
        expect(
            mentionRepo.writeChanged([
                { mediaId: "m1", mentions: [{ tagId: "t1", field: "filename" }] },
            ])
        ).toBe(0);

        // A changed answer replaces the item's rows rather than adding to them.
        expect(
            mentionRepo.writeChanged([
                {
                    mediaId: "m1",
                    mentions: [
                        { tagId: "t2", field: "title" },
                        { tagId: "t2", field: "screen" },
                    ],
                },
            ])
        ).toBe(1);
        expect(rows()).toEqual(["m1:t2:screen", "m1:t2:title"]);
    });

    it("skips a tag deleted since the matcher was built, and counts items once", () => {
        addMedia("m1");
        addTag("t1", "One");

        mentionRepo.writeChanged([
            {
                mediaId: "m1",
                mentions: [
                    { tagId: "t1", field: "filename" },
                    { tagId: "t1", field: "title" },
                    { tagId: "gone", field: "filename" },
                ],
            },
        ]);

        expect(rows()).toEqual(["m1:t1:filename", "m1:t1:title"]);
        expect(mentionRepo.countMentioned("t1")).toBe(1);
    });

    it("stops offering an item somebody said is not them, and keeps the match", () => {
        db.prepare(
            `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
             VALUES ('root', '/media', 'Media', 1, CURRENT_TIMESTAMP)`
        ).run();

        for (const id of ["m1", "m2"]) {
            addMedia(id);
            db.prepare(
                `UPDATE "Media" SET "listable" = 1, "listRootId" = 'root' WHERE "id" = ?`
            ).run(id);
        }

        addTag("t1", "One");
        mentionRepo.writeChanged([
            { mediaId: "m1", mentions: [{ tagId: "t1", field: "filename" }] },
            { mediaId: "m2", mentions: [{ tagId: "t1", field: "title" }] },
        ]);

        // m3 names nothing: a refusal only lands where there is a match to refuse.
        expect(mentionRepo.refuse("t1", ["m1", "m3"], "someone")).toBe(1);
        expect(mentionRepo.refuse("t1", ["m1"], "someone")).toBe(0);
        expect(mentionRepo.untaggedMentions("t1", ["root"]).map((row) => row.mediaId)).toEqual([
            "m2",
        ]);
        expect(
            db
                .prepare(`SELECT m."id" FROM "Media" m WHERE ${mentionRepo.MENTION_FILTER_SQL}`)
                .pluck()
                .all({ mentions: "t1" })
        ).toEqual(["m2"]);
        expect(db.prepare(mentionRepo.MENTIONED_IDS_SQL).pluck().all({ mentions: "t1" })).toEqual([
            "m2",
        ]);
        expect(rows()).toEqual(["m1:t1:filename", "m2:t1:title"]);
    });

    it("names the library performers an item shows that it does not carry, unrefused", () => {
        addMedia("m1");
        addTag("t1", "One");
        addTag("t2", "Two");
        addTag("t3", "Three");
        db.prepare(
            `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
             VALUES ('k1', 'keyword', 'Beach', 'beach', CURRENT_TIMESTAMP)`
        ).run();
        mentionRepo.writeChanged([
            {
                mediaId: "m1",
                mentions: [
                    { tagId: "t1", field: "filename" },
                    { tagId: "t2", field: "title" },
                    { tagId: "t3", field: "screen" },
                    { tagId: "k1", field: "filename" },
                ],
            },
        ]);
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId") VALUES ('x', 'm1', 't2')`
        ).run();
        mentionRepo.refuse("t3", ["m1"], "someone");

        expect(mentionRepo.untaggedPerformersNamedOn("m1")).toEqual([
            { tagId: "t1", field: "filename" },
        ]);
    });
});
