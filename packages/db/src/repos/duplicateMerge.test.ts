import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The rows that move when a duplicate is eliminated (§10c).
 *
 * The conflict rules themselves are pure and tested in `@private-stock/core`; what is left
 * here is the part only a real database can answer — which copy is offered as the heir, what
 * the unique indexes do to a tag that is already on both, and whether a playlist keeps its
 * order. Every one of those fails silently: nothing throws when a rating quietly fails to
 * arrive, and the only person who would notice is the one who recorded it, weeks later.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const dupeRepo = await import("./dupeRepo.js");
const tagRepo = await import("./tagRepo.js");
const playlistRepo = await import("./playlistRepo.js");
const userMediaRepo = await import("./userMediaRepo.js");
const { db: sharedDb } = await import("../db.js");

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "PlaylistItem"; DELETE FROM "Playlist";
        DELETE FROM "UserMedia"; DELETE FROM "MediaTag"; DELETE FROM "Tag";
        DELETE FROM "DupeMember"; DELETE FROM "DupeGroup";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES ('r1', '/media/v', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES ('u1', 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                ('u2', 'bob@example.test', 'Bob', 'x', CURRENT_TIMESTAMP)`
    ).run();
});

interface MediaOptions {
    width?: number;
    height?: number;
    state?: "active" | "trashed";
}

const givenMedia = (id: string, options: MediaOptions = {}): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "width", "height", "addedAt", "updatedAt")
         VALUES (?, 'video', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, options.width ?? 1280, options.height ?? 720);

    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "state", "classification", "lastSeenAt", "updatedAt")
         VALUES (?, 'r1', ?, 10, CURRENT_TIMESTAMP, ?, ?, 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, `${id}.mp4`, `q-${id}`, options.state ?? "active");

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);

    return id;
};

const givenGroup = (...mediaIds: string[]): void => {
    dupeRepo.upsertGroup({
        kind: "exact",
        members: mediaIds.map((mediaId) => ({ mediaId, distance: 0 })),
    });
};

/** A tag in one of the two systems: public by default, or owned by `ownerId` (§6). */
const givenTag = (id: string, name: string, ownerId: string | null = null): string => {
    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "ownerId", "updatedAt")
         VALUES (?, 'tag', ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, name, name.toLowerCase(), ownerId);

    return id;
};

describe("finding the copy that inherits", () => {
    it("offers the other members of the group", () => {
        givenMedia("a");
        givenMedia("b");
        givenGroup("a", "b");

        expect(dupeRepo.activeSiblings("a").map((row) => row.mediaId)).toEqual(["b"]);
    });

    it("never offers the item itself", () => {
        givenMedia("a");
        givenMedia("b");
        givenGroup("a", "b");

        expect(dupeRepo.activeSiblings("a").map((row) => row.mediaId)).not.toContain("a");
    });

    /**
     * A copy already in the bin cannot inherit: it is on its way out, and its retention
     * window may close before the one being deleted now. Bequeathing to it would put the
     * rating on the item most likely to be destroyed next.
     */
    it("passes over a copy that is already trashed", () => {
        givenMedia("a");
        givenMedia("b", { state: "trashed" });
        givenGroup("a", "b");

        expect(dupeRepo.activeSiblings("a")).toEqual([]);
    });

    it("says nothing about an item that is not a duplicate of anything", () => {
        givenMedia("a");

        expect(dupeRepo.activeSiblings("a")).toEqual([]);
    });

    it("carries the fields the keep-preference is decided on", () => {
        givenMedia("a");
        givenMedia("b", { width: 1920, height: 1080 });
        givenGroup("a", "b");

        expect(dupeRepo.activeSiblings("a")[0]).toMatchObject({
            mediaId: "b",
            width: 1920,
            height: 1080,
            sizeBytes: 10,
        });
    });
});

describe("reading and writing a whole overlay", () => {
    it("returns every viewer's record, not one viewer's", () => {
        givenMedia("a");
        userMediaRepo.setRating("u1", "a", 4);
        userMediaRepo.setFavorite("u2", "a", true);

        const rows = userMediaRepo.listOverlays("a");

        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.userId === "u1")?.rating).toBe(4);
        expect(rows.find((row) => row.userId === "u2")?.favorite).toBe(true);
    });

    it("reads the flags back as booleans rather than as 1 and null", () => {
        givenMedia("a");
        userMediaRepo.setRating("u1", "a", 3);

        expect(userMediaRepo.listOverlays("a")[0]).toMatchObject({
            favorite: false,
            hidden: false,
        });
    });

    it("creates the row for a viewer who had never touched the item", () => {
        givenMedia("a");
        userMediaRepo.writeOverlay("u1", "a", {
            rating: 5,
            favorite: true,
            hidden: false,
            viewCount: 2,
            lastViewedAt: "2026-01-01 10:00:00",
            watchedAt: "2026-01-01 10:00:30",
            note: "inherited",
        });

        expect(userMediaRepo.listOverlays("a")[0]).toMatchObject({
            userId: "u1",
            rating: 5,
            favorite: true,
            viewCount: 2,
            note: "inherited",
        });
    });

    /** The partial indexes are defined on `IS NOT NULL`, so a stored 0 would silently join them. */
    it("stores a false flag as null", () => {
        givenMedia("a");
        userMediaRepo.writeOverlay("u1", "a", {
            rating: null,
            favorite: false,
            hidden: false,
            viewCount: 0,
            lastViewedAt: null,
            watchedAt: null,
            note: null,
        });

        const stored = db
            .prepare(`SELECT "favorite", "hidden" FROM "UserMedia" WHERE "userId" = 'u1'`)
            .get() as { favorite: number | null; hidden: number | null };

        expect(stored).toEqual({ favorite: null, hidden: null });
    });
});

describe("copying tag assignments to the surviving copy", () => {
    it("carries the library's tags across", () => {
        givenMedia("a");
        givenMedia("b");
        const funny = givenTag("t1", "funny");

        tagRepo.assign({
            mediaId: "a",
            tagId: funny,
            userId: null,
            createdById: "u1",
            source: "user",
        });

        expect(tagRepo.copyAssignments("a", "b")).toBe(1);
        expect(tagRepo.listForMedia("b", null).map((row) => row.name)).toEqual(["funny"]);
    });

    /**
     * The merge runs as an administrator, over data they cannot see. A copy that carried only
     * the visible half would quietly discard everybody else's private tagging on the way
     * past — the exact failure the per-user scope exists to prevent (§6).
     */
    it("carries another viewer's private tags too", () => {
        givenMedia("a");
        givenMedia("b");
        // A private tag, owned by u2: the two systems pair exactly, so a tag assigned to a
        // person is a tag that person owns (§6).
        const clown = givenTag("t1", "clown", "u2");

        tagRepo.assign({
            mediaId: "a",
            tagId: clown,
            userId: "u2",
            createdById: "u2",
            source: "user",
        });
        tagRepo.copyAssignments("a", "b");

        expect(tagRepo.listForMedia("b", "u2").map((row) => row.name)).toEqual(["clown"]);
        expect(tagRepo.listForMedia("b", null)).toEqual([]);
    });

    it("leaves the departing copy's tags where they are, so a restore is whole", () => {
        givenMedia("a");
        givenMedia("b");
        tagRepo.assign({
            mediaId: "a",
            tagId: givenTag("t1", "funny"),
            userId: null,
            createdById: "u1",
        });

        tagRepo.copyAssignments("a", "b");

        expect(tagRepo.listForMedia("a", null)).toHaveLength(1);
    });

    it("is a no-op on a tag the survivor already carries", () => {
        givenMedia("a");
        givenMedia("b");
        const funny = givenTag("t1", "funny");

        tagRepo.assign({ mediaId: "a", tagId: funny, userId: null, createdById: "u1" });
        tagRepo.assign({ mediaId: "b", tagId: funny, userId: null, createdById: "u1" });

        expect(tagRepo.copyAssignments("a", "b")).toBe(0);
        expect(tagRepo.listForMedia("b", null)).toHaveLength(1);
    });

    it("can run twice without doubling anything", () => {
        givenMedia("a");
        givenMedia("b");
        tagRepo.assign({
            mediaId: "a",
            tagId: givenTag("t1", "funny"),
            userId: null,
            createdById: "u1",
        });

        tagRepo.copyAssignments("a", "b");

        expect(tagRepo.copyAssignments("a", "b")).toBe(0);
        expect(tagRepo.listForMedia("b", null)).toHaveLength(1);
    });
});

describe("taking the departing copy's place in a playlist", () => {
    /** Distinct names, because `UNIQUE (ownerId, name)` is now the point of that constraint. */
    let nextName = 0;

    const givenPlaylist = (mediaIds: string[]): string => {
        const id = playlistRepo.create({
            ownerId: "u1",
            name: `Evening ${(nextName += 1)}`,
            description: null,
            visibility: "private",
            pinned: false,
        });

        playlistRepo.addItems(id, mediaIds);

        return id;
    };

    it("keeps the slot rather than appending at the end", () => {
        givenMedia("x");
        givenMedia("a");
        givenMedia("z");
        const playlist = givenPlaylist(["x", "a", "z"]);
        givenMedia("b");

        expect(playlistRepo.repointItems("a", "b")).toBe(1);
        expect(playlistRepo.listItemIds(playlist, 10, 0)).toEqual(["x", "b", "z"]);
    });

    /**
     * A move rather than a copy: leaving both in would make anybody playing the list through
     * watch the same thing twice for the length of the retention window.
     */
    it("leaves the departing copy out of the playlist", () => {
        givenMedia("a");
        givenMedia("b");
        const playlist = givenPlaylist(["a"]);

        playlistRepo.repointItems("a", "b");

        expect(playlistRepo.listItemIds(playlist, 10, 0)).toEqual(["b"]);
    });

    /** The unique index says the survivor is already in the right place; nothing to do. */
    it("does not add a second entry to a playlist holding both", () => {
        givenMedia("a");
        givenMedia("b");
        const playlist = givenPlaylist(["a", "b"]);

        expect(playlistRepo.repointItems("a", "b")).toBe(0);
        expect(playlistRepo.listItemIds(playlist, 10, 0)).toEqual(["a", "b"]);
    });

    it("moves the item in every playlist that held it", () => {
        givenMedia("a");
        givenMedia("b");
        const first = givenPlaylist(["a"]);
        const second = givenPlaylist(["a"]);

        expect(playlistRepo.repointItems("a", "b")).toBe(2);
        expect(playlistRepo.listItemIds(first, 10, 0)).toEqual(["b"]);
        expect(playlistRepo.listItemIds(second, 10, 0)).toEqual(["b"]);
    });
});
