import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Tags' pictures (§6 "A tag's picture"), against a real database: which one a viewer is shown,
 * and what happens to them when the item or the tag under them changes.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagRepo = await import("./tagRepo.js");
const tagPictureRepo = await import("./tagPictureRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADA = "u-ada";
const SHOWN = "m-shown";
const OTHER = "m-other";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "TagPicture"; DELETE FROM "MediaTag"; DELETE FROM "TagAlias";
        DELETE FROM "Tag"; DELETE FROM "Media"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA);
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
         VALUES (?, 'video', 'Shown', 1, 'root', CURRENT_TIMESTAMP),
                (?, 'video', 'Other', 1, 'root', CURRENT_TIMESTAMP)`
    ).run(SHOWN, OTHER);
});

const picture = (tagId: string, source: "user" | "auto", mediaId: string) =>
    tagPictureRepo.upsert({
        tagId,
        source,
        relPath: `tags/${tagId.slice(0, 2)}/${tagId}-${source}-large.webp`,
        smallRelPath: `tags/${tagId.slice(0, 2)}/${tagId}-${source}-small.webp`,
        mediaId,
        atMs: 1000,
        crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.8 },
        setByUserId: source === "user" ? ADA : null,
    });

const shown = (tagId: string, rootIds = ["root"]) =>
    tagPictureRepo.effectiveFor([tagId], rootIds).get(tagId)?.source ?? null;

describe("the picture a viewer is shown", () => {
    it("is the chosen one over the automatic one, and the automatic one once that goes", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);

        picture(jane, "auto", SHOWN);
        expect(shown(jane)).toBe("auto");

        picture(jane, "user", OTHER);
        expect(shown(jane)).toBe("user");

        tagPictureRepo.remove(jane, "user");
        expect(shown(jane)).toBe("auto");
    });

    it("follows the item it was taken from into the trash, and outlives its purge", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);

        picture(jane, "user", SHOWN);
        db.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = ?`).run(SHOWN);
        expect(shown(jane)).toBeNull();

        db.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run(SHOWN);
        expect(tagPictureRepo.find(jane, "user")?.mediaId).toBeNull();
        expect(shown(jane)).toBe("user");
    });

    it("is not shown from a library the viewer cannot reach", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);

        picture(jane, "user", SHOWN);
        expect(shown(jane, ["elsewhere"])).toBeNull();
    });

    it("moves the time on when it is replaced, so its URL changes", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);
        const first = picture(jane, "user", SHOWN).generatedAt;
        const second = picture(jane, "user", OTHER).generatedAt;

        expect(second > first).toBe(true);
    });
});

describe("a merge", () => {
    it("carries the folded tag's chosen picture to a survivor without one", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);
        const doe = tagRepo.ensureTag("performer", "Jane Doe", null);

        picture(jane, "user", SHOWN);
        picture(jane, "auto", SHOWN);
        tagRepo.mergeTags(jane, doe);

        expect(tagPictureRepo.find(doe, "user")?.mediaId).toBe(SHOWN);
        // The automatic one was read from the folded tag's faces; the job reads the survivor's.
        expect(tagPictureRepo.find(doe, "auto")).toBeUndefined();
    });

    it("keeps the survivor's own chosen picture", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);
        const doe = tagRepo.ensureTag("performer", "Jane Doe", null);

        picture(jane, "user", SHOWN);
        picture(doe, "user", OTHER);
        tagRepo.mergeTags(jane, doe);

        expect(tagPictureRepo.find(doe, "user")?.mediaId).toBe(OTHER);
    });
});

describe("the automatic pictures each job keeps", () => {
    it("are the performers' for the faces job and everybody else's for the looks job", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);
        const beach = tagRepo.ensureTag("tag", "Beach", null);

        picture(jane, "auto", SHOWN);
        picture(beach, "auto", SHOWN);
        picture(beach, "user", SHOWN);

        expect(tagPictureRepo.listAuto("performers").map((row) => row.tagId)).toEqual([jane]);
        expect(tagPictureRepo.listAuto("others").map((row) => row.tagId)).toEqual([beach]);
    });

    it("reads a look from listable items of tags that are not performers", () => {
        const jane = tagRepo.ensureTag("performer", "Jane", null);
        const beach = tagRepo.ensureTag("tag", "Beach", null);

        for (const tagId of [jane, beach]) {
            for (const mediaId of [SHOWN, OTHER]) {
                tagRepo.assign({ mediaId, tagId, userId: null, createdById: ADA });
            }
        }

        db.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = ?`).run(OTHER);

        expect(tagPictureRepo.lookPictureMembers()).toEqual([{ tagId: beach, mediaId: SHOWN }]);
        expect(tagPictureRepo.listableMediaIds()).toEqual([SHOWN]);
    });
});
