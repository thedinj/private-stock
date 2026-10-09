import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipQuery } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Tags on clips (§14d "Tagging clips").
 *
 * The claims that fail silently if wrong:
 *
 *  - **The pairing holds**: a private tag goes only on its owner's clips, and `source` not at all.
 *  - **The tag lifecycle sees clips.** Pruning, merging, publishing and the "unused" list all used
 *    to ask `MediaTag` alone, and each would quietly strip or strand a clip's tag.
 *  - **The two search fields mean different things**, and "or its video" widens exactly one pick.
 *  - **A clip batch is its owner's alone**, never an administrator's to find.
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
const tagBatchRepo = await import("./tagBatchRepo.js");
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

const publicTag = (name: string, kind = "tag"): string => tagRepo.ensureTag(kind, name, null, USER);
const privateTag = (name: string, owner = USER): string =>
    tagRepo.ensureTag("tag", name, owner, owner);

const tagMedia = (mediaId: string, tagId: string, owner: string | null = null): void =>
    tagRepo.assign({ mediaId, tagId, userId: owner, createdById: USER });

const tagsOn = (clipId: string): string[] =>
    (clipTagRepo.listForClipIds([clipId]).get(clipId) ?? []).map((row) => row.name);

const find = (query: Partial<ClipQuery>, userId = USER): string[] =>
    clipRepo
        .search(
            { sort: "startMs", limit: 200, page: 0, ...query } as ClipQuery,
            { userId, accessibleRootIds: null },
            "asc"
        )
        .map((row) => row.id);

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

describe("the pairing", () => {
    it("puts a public tag on anybody's clip", () => {
        addMedia("a");
        const clip = newClip("a", FRIEND);

        clipTagRepo.assign({ clipId: clip, tagId: publicTag("jumping") });

        expect(tagsOn(clip)).toEqual(["jumping"]);
    });

    it("puts a private tag on its owner's clip and nobody else's", () => {
        addMedia("a");
        const mine = newClip("a");
        const theirs = newClip("a", FRIEND);
        const tag = privateTag("funny");

        clipTagRepo.assign({ clipId: mine, tagId: tag });

        expect(tagsOn(mine)).toEqual(["funny"]);
        expect(() => clipTagRepo.assign({ clipId: theirs, tagId: tag })).toThrow(/private/);
    });

    it("refuses a source on a clip", () => {
        addMedia("a");
        const clip = newClip("a");

        expect(() =>
            clipTagRepo.assign({ clipId: clip, tagId: publicTag("Camcorder", "source") })
        ).toThrow(/source/);
    });

    it("carries a tag once however often it is applied", () => {
        addMedia("a");
        const clip = newClip("a");
        const tag = publicTag("jumping");

        expect(clipTagRepo.assign({ clipId: clip, tagId: tag })).toBe(true);
        expect(clipTagRepo.assign({ clipId: clip, tagId: tag })).toBe(false);
        expect(tagsOn(clip)).toEqual(["jumping"]);
    });

    it("goes with the clip", () => {
        addMedia("a");
        const clip = newClip("a");
        clipTagRepo.assign({ clipId: clip, tagId: publicTag("jumping") });

        clipRepo.remove(clip);

        expect(db.prepare(`SELECT count(*) AS n FROM "ClipTag"`).get()).toEqual({ n: 0 });
    });

    it("loses a deleted account's private tags and keeps the library's on the orphaned clip", () => {
        addMedia("a");
        const clip = newClip("a", FRIEND);
        clipTagRepo.assign({ clipId: clip, tagId: privateTag("theirs", FRIEND) });
        clipTagRepo.assign({ clipId: clip, tagId: publicTag("jumping") });

        db.prepare(`DELETE FROM "User" WHERE "id" = ?`).run(FRIEND);

        expect(tagsOn(clip)).toEqual(["jumping"]);
    });
});

describe("the tag lifecycle", () => {
    it("keeps a tag a clip still uses when its last item lets go of it", () => {
        addMedia("a");
        const clip = newClip("a");
        const tag = publicTag("pool");
        tagMedia("a", tag);
        clipTagRepo.assign({ clipId: clip, tagId: tag });

        tagRepo.unassign("a", tag, null);

        expect(tagRepo.findById(tag)).toBeDefined();
        expect(tagsOn(clip)).toEqual(["pool"]);
    });

    it("prunes a tag when the last clip lets go of it", () => {
        addMedia("a");
        const clip = newClip("a");
        const tag = publicTag("jumpign");
        clipTagRepo.assign({ clipId: clip, tagId: tag });

        clipTagRepo.unassign(clip, tag);

        expect(tagRepo.findById(tag)).toBeUndefined();
    });

    it("moves clips with a merge, once each", () => {
        addMedia("a");
        const one = newClip("a");
        const both = newClip("a");
        const source = publicTag("jumpin");
        const target = publicTag("jumping");
        clipTagRepo.assign({ clipId: one, tagId: source });
        clipTagRepo.assign({ clipId: both, tagId: source });
        clipTagRepo.assign({ clipId: both, tagId: target });

        tagRepo.mergeTags(source, target);

        expect(tagsOn(one)).toEqual(["jumping"]);
        expect(tagsOn(both)).toEqual(["jumping"]);
    });

    it("moves clips when a private tag is published onto an existing name", () => {
        addMedia("a");
        const clip = newClip("a");
        const mine = privateTag("pool");
        const library = publicTag("pool");
        clipTagRepo.assign({ clipId: clip, tagId: mine });

        tagRepo.moveAssignments(mine, library, null);

        expect(clipTagRepo.listForClipIds([clip]).get(clip)?.[0]).toMatchObject({
            tagId: library,
            ownerId: null,
        });
    });

    it("counts somebody else's clip as somebody else's use", () => {
        addMedia("a");
        const tag = publicTag("jumping");
        clipTagRepo.assign({ clipId: newClip("a", FRIEND), tagId: tag });

        expect(tagRepo.hasAssignmentsByOthers(tag, USER)).toBe(true);
        expect(tagRepo.hasAssignmentsByOthers(tag, FRIEND)).toBe(false);
    });

    it("refuses to make a tag private while another person's clip carries it", () => {
        addMedia("a");
        const tag = publicTag("jumping");
        clipTagRepo.assign({ clipId: newClip("a", FRIEND), tagId: tag });

        expect(() => tagRepo.setScope(tag, USER)).toThrow(/clips/);
        expect(tagRepo.findById(tag)?.ownerId).toBeNull();
    });

    it("lets the owner make a tag private when only their own clips carry it", () => {
        addMedia("a");
        const tag = publicTag("jumping");
        const clip = newClip("a");
        clipTagRepo.assign({ clipId: clip, tagId: tag });

        tagRepo.setScope(tag, USER);

        expect(clipTagRepo.listForClipIds([clip]).get(clip)?.[0].ownerId).toBe(USER);
    });

    it("does not list a tag only clips carry as unused", () => {
        addMedia("a");
        clipTagRepo.assign({ clipId: newClip("a"), tagId: publicTag("jumping") });
        publicTag("orphan");

        const unused = tagRepo.listVocabulary(null, { unusedOnly: true, limit: 50, offset: 0 });

        expect(unused.rows.map((row) => row.name)).toEqual(["orphan"]);
        expect(unused.total).toBe(1);
    });
});

describe("a clip batch", () => {
    it("tags many clips and is withdrawn exactly", () => {
        addMedia("a");
        const typed = newClip("a");
        const other = newClip("a");
        const tag = publicTag("jumping");
        clipTagRepo.assign({ clipId: typed, tagId: tag });

        const { batchId, assigned } = tagBatchRepo.applyToClips({
            userId: USER,
            summary: "Tagged 2 clips as jumping",
            clipIds: [typed, other],
            tagIds: [tag],
        });

        expect(assigned).toBe(1);
        expect(tagBatchRepo.findById(batchId, USER)).toMatchObject({ mediaCount: 0, clipCount: 2 });

        tagBatchRepo.undo(batchId);

        expect(tagsOn(typed)).toEqual(["jumping"]);
        expect(tagsOn(other)).toEqual([]);
    });

    it("is never found by an administrator", () => {
        addMedia("a");
        const { batchId } = tagBatchRepo.applyToClips({
            userId: FRIEND,
            summary: "Tagged 1 clip as jumping",
            clipIds: [newClip("a", FRIEND)],
            tagIds: [publicTag("jumping")],
        });

        expect(tagBatchRepo.findById(batchId, USER, true)).toBeUndefined();
        expect(tagBatchRepo.listPublic(10)).toEqual([]);
    });
});

describe("searching clips by tag", () => {
    let poolJump: string;
    let poolSwim: string;
    let parkJump: string;
    let mia: string;
    let jumping: string;
    let pool: string;

    beforeEach(() => {
        addMedia("pool-day");
        addMedia("park-day");
        pool = publicTag("pool");
        mia = publicTag("Mia", "performer");
        jumping = publicTag("jumping");
        tagMedia("pool-day", pool);
        tagMedia("pool-day", mia);

        poolJump = newClip("pool-day");
        poolSwim = newClip("pool-day");
        parkJump = newClip("park-day");
        clipTagRepo.assign({ clipId: poolJump, tagId: jumping });
        clipTagRepo.assign({ clipId: poolJump, tagId: mia });
        clipTagRepo.assign({ clipId: parkJump, tagId: jumping });
    });

    it("reads the video's tags for Video has", () => {
        expect(find({ videoTags: [pool] })).toEqual([poolJump, poolSwim]);
        expect(find({ videoNotTags: [pool] })).toEqual([parkJump]);
    });

    it("requires all video tags unless asked for any", () => {
        const park = publicTag("park");
        tagMedia("park-day", park);

        expect(find({ videoTags: [pool, park] })).toEqual([]);
        expect(find({ videoTags: [pool, park], videoMatch: "any" })).toHaveLength(3);
    });

    it("reads the clip's own tags for Clip has", () => {
        expect(find({ clipTags: [jumping] })).toEqual([poolJump, parkJump]);
        expect(find({ clipNotTags: [jumping] })).toEqual([poolSwim]);
        expect(find({ clipTags: [jumping, mia] })).toEqual([poolJump]);
        expect(find({ clipTags: [jumping, mia], clipMatch: "any" })).toEqual([poolJump, parkJump]);
    });

    it("assembles the pool reel from both fields", () => {
        expect(find({ videoTags: [pool], clipTags: [jumping] })).toEqual([poolJump]);
    });

    it("is strict about Clip has unless that pick is widened to the video", () => {
        // Mia is on the whole pool video but tagged on only one of its clips.
        expect(find({ clipTags: [mia] })).toEqual([poolJump]);
        expect(find({ clipTags: [mia], orVideo: [mia] })).toEqual([poolJump, poolSwim]);
    });

    it("reads a widened without as neither the clip nor its video", () => {
        expect(find({ clipNotTags: [mia] })).toEqual([poolSwim, parkJump]);
        expect(find({ clipNotTags: [mia], orVideo: [mia] })).toEqual([parkJump]);
    });

    it("never matches the video on somebody else's private tag", () => {
        const theirs = privateTag("secret", FRIEND);
        tagMedia("park-day", theirs, FRIEND);

        expect(find({ videoTags: [theirs] })).toEqual([]);
    });

    it("counts facets over all your clips, video side and clip side", () => {
        newClip("park-day", FRIEND);
        const facets = clipTagRepo.facetsFor(USER, null);
        const counts = (rows: { name: string; count: number }[]) =>
            Object.fromEntries(rows.map((row) => [row.name, row.count]));

        expect(counts(facets.clip)).toEqual({ jumping: 2, Mia: 1 });
        expect(counts(facets.video)).toEqual({ pool: 2, Mia: 2 });
    });
});
