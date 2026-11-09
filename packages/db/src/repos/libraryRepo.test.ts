import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryQuery } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * The library's query, read by clips and stills (§14e "What a kind is").
 *
 * The claims that fail silently if wrong: a clip answers a tag filter with its own tags and a
 * still with its video's; a filter a kind cannot answer leaves that kind out rather than being
 * ignored for it; and only the viewer's own rows are ever listed.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const clipRepo = await import("./clipRepo.js");
const clipTagRepo = await import("./clipTagRepo.js");
const tagRepo = await import("./tagRepo.js");
const libraryRepo = await import("./libraryRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const USER = "bbbbbbbb-0000-4000-8000-000000000000";
const FRIEND = "bbbbbbbb-0000-4000-8000-000000000001";

const addMedia = (id: string): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "durationMs", "updatedAt")
         VALUES (?, 'video', ?, 600000, CURRENT_TIMESTAMP)`
    ).run(id, id);
    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 1024, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, ROOT, `${id}.mp4`);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);

    return id;
};

let sequence = 0;

const newClip = (mediaId: string, userId = USER): string =>
    clipRepo.create({
        mediaId,
        userId,
        startMs: (sequence += 1) * 1_000,
        endMs: sequence * 1_000 + 5_000,
        label: null,
        speed: null,
    });

const publicTag = (name: string, kind = "tag"): string =>
    tagRepo.ensureTag("cellar", kind, name, null, USER);

const tagMedia = (mediaId: string, tagId: string, owner: string | null = null): void =>
    tagRepo.assign({ mediaId, tagId, userId: owner, createdById: USER });

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

    for (const table of (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)))) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "writable", "updatedAt")
         VALUES (?, '/media/videos', 'Lib', 1, 1, CURRENT_TIMESTAMP)`
    ).run(ROOT);

    for (const [id, email, name] of [
        [USER, "a@b.c", "Curator"],
        [FRIEND, "d@e.f", "Friend"],
    ]) {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
             VALUES (?, ?, ?, 'x', '', CURRENT_TIMESTAMP)`
        ).run(id, email, name);
    }
});

let ordinal = 0;

const newStill = (mediaId: string, userId = USER): string => {
    const id = `still-${(ordinal += 1)}`;

    db.prepare(
        `INSERT INTO "Artifact"
             ("id", "mediaId", "kind", "ordinal", "relPath", "width", "height", "source",
              "createdByUserId")
         VALUES (?, ?, 'capture', ?, ?, 1920, 1080, 'user', ?)`
    ).run(id, mediaId, ordinal, `captures/${id}.jpg`, userId);

    return id;
};

const scope = { userId: USER, accessibleRootIds: null };

const listed = (
    query: Partial<LibraryQuery>,
    types: ("clip" | "capture")[] = ["clip", "capture"]
) =>
    libraryRepo
        .smallKeys(
            { kind: "all", sort: "addedAt", limit: 60, page: 0, ...query } as LibraryQuery,
            scope,
            "addedAt",
            types
        )
        .map((row) => row.id)
        .sort();

describe("the library's query, read by clips and stills", () => {
    it("lists only the viewer's own", () => {
        addMedia("a");
        const mine = newClip("a");
        const still = newStill("a");
        newClip("a", FRIEND);
        newStill("a", FRIEND);

        expect(listed({})).toEqual([mine, still].sort());
    });

    it("reads a clip's own tags and a still's video's", () => {
        addMedia("a");
        addMedia("b");
        const mia = publicTag("Mia", "performer");
        const tagged = newClip("a");
        const untagged = newClip("a");
        const fromTaggedVideo = newStill("a");
        newStill("b");
        clipTagRepo.assign({ clipId: tagged, tagId: mia });
        tagMedia("a", mia);

        expect(listed({ tags: [mia] })).toEqual([fromTaggedVideo, tagged].sort());
        // Widened, the clip of a tagged video matches too.
        expect(listed({ tags: [mia], orVideo: [mia] }, ["clip"])).toEqual(
            [tagged, untagged].sort()
        );
    });

    it("rates clips and leaves stills out of a rating filter", () => {
        addMedia("a");
        const five = newClip("a");
        const none = newClip("a");
        newStill("a");
        clipRepo.setMarks([five], USER, { rating: 5, favorite: true });

        expect(listed({ minRating: 4 })).toEqual([five]);
        expect(listed({ favorite: true })).toEqual([five]);
        expect(listed({ unrated: true })).toEqual([none]);
    });

    it("leaves both out of a filter only an item can answer", () => {
        addMedia("a");
        newClip("a");
        newStill("a");

        expect(listed({ watched: "yes" })).toEqual([]);
        expect(listed({ mentions: "x" })).toEqual([]);
    });

    it("reads a group's rules the same way", () => {
        addMedia("a");
        const loved = newClip("a");
        newClip("a");
        clipRepo.setMarks([loved], USER, { favorite: true });

        expect(
            listed(
                {
                    groups: [
                        {
                            match: "any",
                            rules: [{ t: "favorite" }, { t: "watched", value: "yes" }],
                        },
                    ],
                },
                ["clip"]
            )
        ).toEqual([loved]);
        expect(
            listed({ groups: [{ match: "none", rules: [{ t: "favorite" }] }] }, ["clip"])
        ).toHaveLength(1);
    });

    it("finds clips by name and stills by caption or title", () => {
        addMedia("Holiday");
        const named = clipRepo.create({
            mediaId: "Holiday",
            userId: USER,
            startMs: 0,
            endMs: 5_000,
            label: "Cannonball",
            speed: null,
        });
        newClip("Holiday");
        const still = newStill("Holiday");

        expect(listed({ search: "cannon" })).toEqual([named]);
        expect(listed({ search: "holi" })).toEqual([still]);
    });

    it("keeps a clip that is in no reel for 'not in a reel', and no still", () => {
        addMedia("a");
        const clip = newClip("a");
        newStill("a");

        expect(listed({ unusedOnly: true })).toEqual([clip]);
    });

    it("keys by run time for duration, and stills have none", () => {
        addMedia("a");
        newClip("a");
        newStill("a");

        const keys = libraryRepo
            .smallKeys(
                { kind: "all", sort: "duration", limit: 60, page: 0 } as LibraryQuery,
                scope,
                "duration",
                ["clip", "capture"]
            )
            .map((row) => [row.type, row.k]);

        expect(keys).toContainEqual(["clip", 5_000]);
        expect(keys).toContainEqual(["capture", null]);
    });
});

describe("the tag lists, with your clips counted", () => {
    const browse = (viewerId: string) =>
        tagRepo.browseTags("cellar", null, {
            kind: "tag",
            sort: "count",
            viewerId,
            rootIds: [ROOT],
            limit: 60,
            offset: 0,
        }).rows;

    it("lists a tag only your clips carry, after the ones items carry", () => {
        addMedia("a");
        const onItems = publicTag("pool");
        const onClipsOnly = publicTag("jumping");
        tagMedia("a", onItems);
        clipTagRepo.assign({ clipId: newClip("a"), tagId: onClipsOnly });

        expect(browse(USER).map((row) => [row.name, row.videoCount, row.clipCount])).toEqual([
            ["pool", 1, 0],
            ["jumping", 0, 1],
        ]);
    });

    it("never counts somebody else's clips", () => {
        addMedia("a");
        clipTagRepo.assign({ clipId: newClip("a", FRIEND), tagId: publicTag("jumping") });

        expect(browse(USER)).toEqual([]);
        expect(browse(FRIEND).map((row) => row.clipCount)).toEqual([1]);
    });
});
