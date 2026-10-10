import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Tagging by itself (§5f): the evidence per person in an item, what may never be proposed, a
 * checked pair staying checked, and each rule's own tally.
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

/** An item in the library with people in it, each matched to a performer at a score and margin. */
const item = (
    id: string,
    people: {
        tagId: string;
        score: number;
        second?: number;
        moments?: number;
        legible?: boolean;
    }[]
) => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "listable", "listRootId", "updatedAt")
         VALUES (?, 'video', ?, 1, 'root', CURRENT_TIMESTAMP)`
    ).run(id, id);

    let index = 0;

    people.forEach((person, p) => {
        const appearanceId = `${id}-p${p}`;

        db.prepare(
            `INSERT INTO "FaceAppearance"
                 ("id", "mediaId", "faceCount", "bestFaceId", "legible", "matchTagId", "score", "second")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            appearanceId,
            id,
            person.moments ?? 3,
            `${id}-${index}`,
            person.legible === false ? null : 1,
            person.tagId,
            person.score,
            person.second ?? 0.1
        );

        for (let m = 0; m < (person.moments ?? 3); m += 1, index += 1) {
            db.prepare(
                `INSERT INTO "Face" ("id", "mediaId", "vectorIndex", "atMs", "x", "y", "w", "h",
                                     "eyes", "score", "appearanceId")
                 VALUES (?, ?, ?, ?, 0.1, 0.1, 0.2, 0.3, 20, 0.9, ?)`
            ).run(`${id}-${index}`, id, index, index * 1000, appearanceId);
        }
    });
};

const proposal = (mediaId: string, strongFaces = 3) => ({
    mediaId,
    tagId: "jane",
    faceId: `${mediaId}-0`,
    bestScore: 0.8,
    strongFaces,
    named: 0 as const,
});

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
    it("reads the surest person an item: how often seen, their score, best face, and name", () => {
        item("a", [
            { tagId: "jane", score: 0.65, moments: 2 },
            { tagId: "jane", score: 0.7, moments: 4 },
        ]);
        db.prepare(
            `INSERT INTO "MediaMention" ("mediaId", "tagId", "field") VALUES ('a', 'jane', 'filename')`
        ).run();

        expect(repo.candidates(0.6, 0.1)).toEqual([
            {
                mediaId: "a",
                tagId: "jane",
                faceId: "a-2",
                kind: "video",
                bestScore: 0.7,
                strongFaces: 4,
                named: 1,
                anchorItems: 6,
            },
        ]);
    });

    it("never proposes what was refused, is tagged, is close to somebody else, or was checked", () => {
        item("seen", [{ tagId: "jane", score: 0.8 }]);
        item("unseen", [{ tagId: "jane", score: 0.8 }]);
        item("item", [{ tagId: "jane", score: 0.8 }]);
        item("tagged", [{ tagId: "jane", score: 0.8 }]);
        item("close", [{ tagId: "jane", score: 0.8, second: 0.75 }]);
        item("small", [{ tagId: "jane", score: 0.8, legible: false }]);
        item("checked", [{ tagId: "jane", score: 0.8 }]);
        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how") VALUES ('seen-1', 'jane', 'shown')`
        ).run();
        // A refusal carried to a face nobody saw does not speak for the person.
        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how") VALUES ('unseen-1', 'jane', 'inferred')`
        ).run();
        db.prepare(`INSERT INTO "ItemRefusal" ("tagId", "mediaId") VALUES ('jane', 'item')`).run();
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId") VALUES ('t', 'tagged', 'jane')`
        ).run();
        repo.replaceProposals([proposal("checked")], 2);
        repo.decide("checked", "jane", "wrong", "someone");

        expect(repo.candidates(0.6, 0.1).map((row) => row.mediaId)).toEqual(["unseen"]);
    });

    it("rewrites proposals each run, keeps what was checked, and tallies each rule's own", () => {
        item("a", [{ tagId: "jane", score: 0.8 }]);
        item("b", [{ tagId: "jane", score: 0.8 }]);
        item("c", [{ tagId: "jane", score: 0.8 }]);

        repo.replaceProposals([proposal("c")], 1);
        repo.decide("c", "jane", "wrong", "someone");
        repo.replaceProposals([proposal("a"), proposal("b")], 2);
        repo.decide("a", "jane", "right", "someone");
        repo.replaceProposals([], 2);

        expect(repo.counts()).toEqual({ proposed: 0, right: 1, wrong: 1, applied: 0, removed: 0 });
        expect(repo.trial(2)).toEqual({ right: 1, wrong: 0 });
        expect(repo.trial(1)).toEqual({ right: 0, wrong: 1 });
        expect(repo.find("a", "jane")?.state).toBe("right");
        expect(repo.inState("right", ["root"]).map((r) => r.mediaId)).toEqual(["a"]);
        expect(repo.inState("right", [])).toEqual([]);
    });

    it("marks a tag made by faces as taken back, and only one that was applied", () => {
        item("a", [{ tagId: "jane", score: 0.8 }]);
        item("b", [{ tagId: "jane", score: 0.8 }]);

        repo.replaceProposals([proposal("a"), proposal("b")], 2);
        repo.decide("a", "jane", "applied", null);

        expect(repo.markRemoved(["a", "b"], "jane", "someone")).toBe(1);
        expect(repo.counts()).toMatchObject({ proposed: 1, applied: 0, removed: 1 });
    });
});
