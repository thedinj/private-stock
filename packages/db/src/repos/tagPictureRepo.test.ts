import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The stand-in moment for a source or a keyword with no typical frame (§6 "A tag's picture"):
 * somebody's capture first, else a cover, only where the moment is known, only on items anybody
 * can see.
 */

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagPictureRepo = await import("./tagPictureRepo.js");
const { db } = await import("../db.js");

const item = (id: string, kind: "video" | "image"): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "updatedAt")
         VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`
    ).run(id, kind, id);
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt",
                                  "updatedAt")
         VALUES (?, 'root', ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`file-${id}`, `${id}.mp4`);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`link-${id}`, id, `file-${id}`);
    db.prepare(
        `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES (?, ?, 'beach', 'user')`
    ).run(`${id}-beach`, id);
};

const artifact = (id: string, mediaId: string, kind: string, atMs: number | null): void => {
    db.prepare(
        `INSERT INTO "Artifact" ("id", "mediaId", "kind", "relPath", "atMs")
         VALUES (?, ?, ?, ?, ?)`
    ).run(id, mediaId, kind, `art/${id}.webp`, atMs);
};

beforeEach(() => {
    db.pragma("foreign_keys = OFF");

    for (const { name } of db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "updatedAt")
         VALUES ('root', '/media', 'Media', CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
         VALUES ('beach', 'tag', 'beach', 'beach', CURRENT_TIMESTAMP)`
    ).run();
});

describe("standInFor", () => {
    it("takes somebody's capture before any cover", () => {
        item("a", "video");
        item("b", "video");
        artifact("1-cover", "a", "cover", 5000);
        artifact("9-capture", "b", "capture", 12000);

        expect(tagPictureRepo.standInFor("beach")).toEqual({
            mediaId: "b",
            kind: "video",
            atMs: 12000,
            fileId: "file-b",
        });
    });

    it("passes over a video's cover with no moment, but not a photograph's", () => {
        item("a", "video");
        item("p", "image");
        artifact("1-cover", "a", "cover", null);
        artifact("2-cover", "p", "cover", null);

        expect(tagPictureRepo.standInFor("beach")?.mediaId).toBe("p");
    });

    it("offers nothing from an item in the trash", () => {
        item("a", "video");
        artifact("1-cover", "a", "cover", 5000);
        db.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = 'a'`).run();

        expect(tagPictureRepo.standInFor("beach")).toBeUndefined();
    });
});
