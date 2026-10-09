import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Tagging by itself (§5f): the evidence per item and performer, what may never be proposed, and
 * a checked pair staying checked.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const repo = await import("./faceAutoTagRepo.js");
const { db: sharedDb } = await import("../db.js");

/** An item in the library with faces, each matched to a performer at a score and margin. */
const item = (
    id: string,
    faces: { atMs: number; tagId: string; score: number; second?: number }[]
) => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
         VALUES (?, 'video', ?, 1, 'root', CURRENT_TIMESTAMP)`
    ).run(id, id);
    faces.forEach((face, i) => {
        db.prepare(
            `INSERT INTO "Face" ("id", "mediaId", "vectorIndex", "atMs", "x", "y", "w", "h", "eyes", "score")
             VALUES (?, ?, ?, ?, 0.1, 0.1, 0.2, 0.3, 20, 0.9)`
        ).run(`${id}-${i}`, id, i, face.atMs);
        db.prepare(
            `INSERT INTO "FaceMatch" ("faceId", "tagId", "score", "second") VALUES (?, ?, ?, ?)`
        ).run(`${id}-${i}`, face.tagId, face.score, face.second ?? 0.1);
    });
};

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");
    for (const { name } of db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]) {
        if (!name.includes("_")) db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES ('someone', 'someone@example.com', 'Someone', 'x', CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES ('root', '/media', 'Media', 1, CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
         VALUES ('jane', 'performer', 'Jane', 'jane', CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "FaceAnchor" ("tagId", "items", "confirmedItems", "sharedItems")
         VALUES ('jane', 6, 2, 5)`
    ).run();
});

describe("tagging by itself", () => {
    it("counts each item's strong faces by moment, its best face, and its name", () => {
        item("a", [
            { atMs: 1000, tagId: "jane", score: 0.7 },
            { atMs: 1000, tagId: "jane", score: 0.65 },
            { atMs: 5000, tagId: "jane", score: 0.62 },
            { atMs: 9000, tagId: "jane", score: 0.5 },
        ]);
        db.prepare(
            `INSERT INTO "MediaMention" ("mediaId", "tagId", "field") VALUES ('a', 'jane', 'filename')`
        ).run();

        expect(repo.candidates(0.45, 0.6, 0.1)).toEqual([
            {
                mediaId: "a",
                tagId: "jane",
                faceId: "a-0",
                bestScore: 0.7,
                strongFaces: 2,
                named: 1,
                anchorItems: 6,
            },
        ]);
    });

    it("never proposes what was refused, is tagged, is close to somebody else, or was checked", () => {
        item("refused", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        item("tagged", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        item("close", [{ atMs: 0, tagId: "jane", score: 0.8, second: 0.75 }]);
        item("checked", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId") VALUES ('refused-0', 'jane')`
        ).run();
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId") VALUES ('t', 'tagged', 'jane')`
        ).run();
        repo.replaceProposals([
            {
                mediaId: "checked",
                tagId: "jane",
                faceId: "checked-0",
                bestScore: 0.8,
                strongFaces: 1,
                named: 0,
            },
        ]);
        repo.decide("checked", "jane", "wrong", "someone");

        expect(repo.candidates(0.45, 0.6, 0.1)).toEqual([]);
    });

    it("rewrites proposals each run and keeps what was checked", () => {
        item("a", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        item("b", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        const row = (mediaId: string) => ({
            mediaId,
            tagId: "jane",
            faceId: `${mediaId}-0`,
            bestScore: 0.8,
            strongFaces: 1,
            named: 0 as const,
        });

        repo.replaceProposals([row("a"), row("b")]);
        repo.decide("a", "jane", "right", "someone");
        repo.replaceProposals([]);

        expect(repo.counts()).toEqual({ proposed: 0, right: 1, wrong: 0, applied: 0, removed: 0 });
        expect(repo.find("a", "jane")?.state).toBe("right");
        expect(repo.inState("right", ["root"]).map((r) => r.mediaId)).toEqual(["a"]);
        expect(repo.inState("right", [])).toEqual([]);
    });

    it("marks a tag made by faces as taken back, and only one that was applied", () => {
        item("a", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        item("b", [{ atMs: 0, tagId: "jane", score: 0.8 }]);
        const row = (mediaId: string) => ({
            mediaId,
            tagId: "jane",
            faceId: `${mediaId}-0`,
            bestScore: 0.8,
            strongFaces: 2,
            named: 0 as const,
        });

        repo.replaceProposals([row("a"), row("b")]);
        repo.decide("a", "jane", "applied", null);

        expect(repo.markRemoved(["a", "b"], "jane", "someone")).toBe(1);
        expect(repo.counts()).toMatchObject({ proposed: 1, applied: 0, removed: 1 });
    });
});
