import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * "Who is this?" (§5f). What matters: searches queue one requested job for their item however many
 * are asked, each runs once, a worker stopped mid-way gives its searches back, a search left with
 * no job is queued again, and old searches do not pile up.
 */

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const faceSearchRepo = await import("./faceSearchRepo.js");
const { db: sharedDb } = await import("../db.js");

let db: Database.Database;
const USER = "33333333-0000-4000-8000-000000000000";

const jobs = () =>
    db
        .prepare(
            `SELECT "mediaId", "fileId", "priority", "requestedByUserId" FROM "Job"
              WHERE "kind" = 'faceSearch'`
        )
        .all();

beforeEach(() => {
    db = sharedDb as Database.Database;
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

    db.exec(`
        INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
        VALUES ('${USER}', 'a@example.com', 'Admin', 'x', 'admin', CURRENT_TIMESTAMP);
        INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
        VALUES ('root', '/media', 'Media', 1, CURRENT_TIMESTAMP);
        INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
        VALUES ('m1', 'video', 'One', CURRENT_TIMESTAMP);
        INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
        VALUES ('f1', 'root', 'one.mp4', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role") VALUES ('l1', 'm1', 'f1', 'original');
    `);
});

describe("asking", () => {
    it("queues one requested job for the item's original, however many searches are asked", () => {
        const first = faceSearchRepo.start("m1", 1000, USER);

        faceSearchRepo.start("m1", 2000, USER);

        expect(jobs()).toEqual([
            { mediaId: "m1", fileId: "f1", priority: 20, requestedByUserId: USER },
        ]);
        expect(faceSearchRepo.nextPending("m1")?.id).toBe(first);
    });

    it("lets searches older than a day go as new ones come", () => {
        const old = faceSearchRepo.start("m1", 1000, USER);

        db.prepare(
            `UPDATE "FaceSearch" SET "requestedAt" = datetime('now', '-2 days') WHERE "id" = ?`
        ).run(old);
        faceSearchRepo.start("m1", 2000, USER);

        expect(faceSearchRepo.find(old)).toBeUndefined();
    });
});

describe("running", () => {
    it("is taken once, and its result written", () => {
        const id = faceSearchRepo.start("m1", 1000, USER);

        expect(faceSearchRepo.markRunning(id)).toBe(true);
        expect(faceSearchRepo.markRunning(id)).toBe(false);

        faceSearchRepo.complete(id, "[]");

        expect(faceSearchRepo.find(id)).toMatchObject({ state: "done", resultJson: "[]" });
    });

    it("records a failure, and only over a search that was running", () => {
        const id = faceSearchRepo.start("m1", 1000, USER);

        faceSearchRepo.fail(id, "too early");
        expect(faceSearchRepo.find(id)?.state).toBe("pending");

        faceSearchRepo.markRunning(id);
        faceSearchRepo.fail(id, "no frame there");
        expect(faceSearchRepo.find(id)).toMatchObject({ state: "failed", error: "no frame there" });
    });

    it("takes back a search a stopped worker left running", () => {
        const id = faceSearchRepo.start("m1", 1000, USER);

        faceSearchRepo.markRunning(id);
        faceSearchRepo.resumeInterrupted("m1");

        expect(faceSearchRepo.nextPending("m1")?.id).toBe(id);
    });

    it("queues the item again for a search left waiting with no job", () => {
        const id = faceSearchRepo.start("m1", 1000, USER);

        db.exec(`DELETE FROM "Job"`);
        faceSearchRepo.requeueIfStranded(faceSearchRepo.find(id)!, USER);
        faceSearchRepo.requeueIfStranded(faceSearchRepo.find(id)!, USER);

        expect(jobs()).toHaveLength(1);
    });
});
