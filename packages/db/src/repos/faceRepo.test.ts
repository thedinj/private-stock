import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The faces an item shows (§5f). The stage replaces them on every run; what matters here is that
 * a person's decision survives that, on the face found again and nowhere else.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const faceRepo = await import("./faceRepo.js");
const tagRepo = await import("./tagRepo.js");
const { db: sharedDb } = await import("../db.js");

const face = (vectorIndex: number, atMs: number | null, x: number, extra = {}) => ({
    vectorIndex,
    atMs,
    x,
    y: 0.1,
    w: 0.2,
    h: 0.3,
    eyes: 20,
    score: 0.9,
    ...extra,
});

const faces = (mediaId: string) =>
    db
        .prepare(
            `SELECT "id", "vectorIndex", "atMs", "x", "tagId" FROM "Face"
              WHERE "mediaId" = ? ORDER BY "vectorIndex"`
        )
        .all(mediaId) as {
        id: string;
        vectorIndex: number;
        atMs: number | null;
        x: number;
        tagId: string | null;
    }[];

const refusals = (mediaId: string) =>
    db
        .prepare(
            `SELECT f."vectorIndex", r."tagId" FROM "FaceRefusal" r JOIN "Face" f ON f."id" = r."faceId"
              WHERE f."mediaId" = ? ORDER BY 1, 2`
        )
        .all(mediaId) as { vectorIndex: number; tagId: string }[];

const confirm = (faceId: string, tagId: string): void => {
    db.prepare(
        `UPDATE "Face" SET "tagId" = ?, "decidedByUserId" = 'someone', "decidedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(tagId, faceId);
};

const refuse = (faceId: string, tagId: string): void => {
    db.prepare(
        `INSERT INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId") VALUES (?, ?, 'someone')`
    ).run(faceId, tagId);
};

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

    for (const id of ["a", "b"]) {
        db.prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
             VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
        ).run(id, id);
    }

    for (const id of ["jane", "kim"]) {
        db.prepare(
            `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
             VALUES (?, 'performer', ?, ?, CURRENT_TIMESTAMP)`
        ).run(id, id, id);
    }
});

describe("replacing an item's faces", () => {
    it("stores what the stage found", () => {
        faceRepo.replaceForMedia("a", [face(0, 2000, 0.1), face(1, 4000, 0.5)]);

        expect(faces("a").map((f) => [f.vectorIndex, f.atMs, f.x])).toEqual([
            [0, 2000, 0.1],
            [1, 4000, 0.5],
        ]);
    });

    it("carries a confirmation and a refusal to the same face found again", () => {
        faceRepo.replaceForMedia("a", [face(0, 2000, 0.1), face(1, 2000, 0.6)]);

        const [left, right] = faces("a");

        confirm(left.id, "jane");
        refuse(right.id, "jane");

        // Found again, a little moved and in another order, beside a new face.
        faceRepo.replaceForMedia("a", [
            face(0, 2000, 0.62),
            face(1, 9000, 0.1),
            face(2, 2000, 0.12),
        ]);

        expect(faces("a").map((f) => [f.vectorIndex, f.tagId])).toEqual([
            [0, null],
            [1, null],
            [2, "jane"],
        ]);
        expect(refusals("a")).toEqual([{ vectorIndex: 0, tagId: "jane" }]);
    });

    it("never moves a decision to a face at another moment, or beside it", () => {
        faceRepo.replaceForMedia("a", [face(0, 2000, 0.1)]);
        confirm(faces("a")[0].id, "jane");

        faceRepo.replaceForMedia("a", [face(0, 6000, 0.1), face(1, 2000, 0.5)]);

        expect(faces("a").map((f) => f.tagId)).toEqual([null, null]);
    });

    it("follows a face whose tile moved a little, to the nearest moment", () => {
        faceRepo.replaceForMedia("a", [face(0, 2000, 0.1)]);
        confirm(faces("a")[0].id, "jane");

        // The sprite's interval changed: the same face is now a second and a half later.
        faceRepo.replaceForMedia("a", [face(0, 3500, 0.1), face(1, 4000, 0.1)]);

        expect(faces("a").map((f) => f.tagId)).toEqual(["jane", null]);
    });

    it("leaves other items alone", () => {
        faceRepo.replaceForMedia("a", [face(0, 2000, 0.1)]);
        faceRepo.replaceForMedia("b", [face(0, 2000, 0.1)]);
        faceRepo.replaceForMedia("a", []);

        expect(faces("a")).toEqual([]);
        expect(faces("b")).toHaveLength(1);
    });
});

describe('carrying a "can\'t tell"', () => {
    it("moves it to the face found again, as a decision is", () => {
        faceRepo.replaceForMedia("a", [face(0, 1000, 0.1), face(1, 1000, 0.6)]);
        db.prepare(
            `UPDATE "Face" SET "skippedAt" = CURRENT_TIMESTAMP, "skippedByUserId" = 'someone'
              WHERE "mediaId" = 'a' AND "vectorIndex" = 1`
        ).run();

        faceRepo.replaceForMedia("a", [face(0, 1000, 0.62), face(1, 1000, 0.1)]);

        expect(
            db
                .prepare(
                    `SELECT "x", "skippedAt" IS NOT NULL AS "skipped" FROM "Face"
                      WHERE "mediaId" = 'a' ORDER BY "vectorIndex"`
                )
                .all()
        ).toEqual([
            { x: 0.62, skipped: 1 },
            { x: 0.1, skipped: 0 },
        ]);
    });
});

describe("borrowing an identical copy's faces", () => {
    it("copies the faces and what was said about them", () => {
        faceRepo.replaceForMedia("a", [face(0, 2000, 0.1), face(1, 4000, 0.5)]);

        const [first, second] = faces("a");

        confirm(first.id, "jane");
        refuse(second.id, "kim");

        expect(faceRepo.copyFromTwin("a", "b")).toBe(2);
        expect(faces("b").map((f) => [f.vectorIndex, f.tagId])).toEqual([
            [0, "jane"],
            [1, null],
        ]);
        expect(refusals("b")).toEqual([{ vectorIndex: 1, tagId: "kim" }]);
        expect(faces("b")[0].id).not.toBe(first.id);
    });

    it("borrows nothing from a copy with no faces", () => {
        expect(faceRepo.copyFromTwin("a", "b")).toBe(0);
    });
});

describe("a performer's faces", () => {
    const ROOT = "root";

    /** Items in the library, each with this many faces and the performers given. */
    const setUp = (items: { id: string; faces: number; performers?: string[] }[]): void => {
        db.prepare(
            `INSERT OR IGNORE INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
             VALUES (?, '/media', 'Media', 1, CURRENT_TIMESTAMP)`
        ).run(ROOT);

        for (const item of items) {
            db.prepare(
                `INSERT OR IGNORE INTO "Media" ("id", "kind", "title", "updatedAt")
                 VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
            ).run(item.id, item.id);
            db.prepare(`UPDATE "Media" SET "listable" = 1, "listRootId" = ? WHERE "id" = ?`).run(
                ROOT,
                item.id
            );
            faceRepo.replaceForMedia(
                item.id,
                Array.from({ length: item.faces }, (_, i) =>
                    face(i, i * 1000, 0.1 * i, { eyes: 20 + i })
                )
            );

            for (const tagId of item.performers ?? []) {
                db.prepare(
                    `INSERT INTO "MediaTag" ("id", "mediaId", "tagId") VALUES (?, ?, ?)`
                ).run(`${item.id}-${tagId}`, item.id, tagId);
            }
        }
    };

    beforeEach(() => {
        for (const id of ["c", "d", "e"]) {
            db.prepare(
                `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
                 VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
            ).run(id, id);
        }
    });

    it("keeps references and best matches whole, and reads them back", () => {
        setUp([
            { id: "a", faces: 1, performers: ["jane"] },
            { id: "b", faces: 1 },
        ]);
        const [fa, fb] = ["a", "b"].map((id) => faces(id)[0].id);

        faceRepo.replaceAnchors(
            [{ tagId: "jane", items: 3, confirmedItems: 0, sharedItems: 3 }],
            [
                { faceId: fa, tagId: "jane", score: 0.7, second: 0.1 },
                { faceId: fb, tagId: "jane", score: 0.6, second: 0.2 },
                { faceId: "gone", tagId: "jane", score: 0.9, second: 0 },
            ]
        );

        expect(faceRepo.anchorOf("jane")).toMatchObject({ items: 3, sharedItems: 3 });

        faceRepo.replaceAnchors([], []);

        expect(faceRepo.anchorOf("jane")).toBeUndefined();
    });

    it("leaves a performer with no single face out of every reference, and back when undone", () => {
        setUp([
            { id: "a", faces: 1, performers: ["kim"] },
            { id: "b", faces: 1, performers: ["jane", "kim"] },
        ]);
        confirm(faces("a")[0].id, "kim");

        faceRepo.setNoSingleFace("kim", true, "someone");

        expect(faceRepo.noSingleFace("kim")).toBeDefined();
        expect(faceRepo.confirmedFaceRefs().some((row) => row.tagId === "kim")).toBe(false);
        expect(faceRepo.taggedFaceRefs(10).some((row) => row.tagId === "kim")).toBe(false);

        faceRepo.setNoSingleFace("kim", false, "someone");

        expect(faceRepo.noSingleFace("kim")).toBeUndefined();
        expect(faceRepo.confirmedFaceRefs().some((row) => row.tagId === "kim")).toBe(true);
    });

    it("finds the faces on each performer's tagged items, not refused, not made by a face", () => {
        setUp([
            { id: "a", faces: 1, performers: ["jane"] },
            { id: "b", faces: 2, performers: ["jane"] },
        ]);
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES ('x', 'b', 'kim', 'ai')`
        ).run();
        refuse(faces("b")[1].id, "jane");

        const rows = faceRepo.taggedFaceRefs(10);

        expect(rows.map((row) => [row.tagId, row.mediaId, row.vectorIndex]).sort()).toEqual([
            ["jane", "a", 0],
            ["jane", "b", 0],
        ]);
    });

    it("pages every confirmed face, every moment, largest first", () => {
        setUp([
            { id: "a", faces: 2 },
            { id: "b", faces: 1 },
        ]);

        for (const row of [...faces("a"), ...faces("b")]) confirm(row.id, "jane");

        const first = faceRepo.everyConfirmedFace("jane", [ROOT], 2, 0);

        expect(first.total).toBe(3);
        expect(first.faces).toHaveLength(2);
        expect(faceRepo.everyConfirmedFace("jane", [ROOT], 2, 2).faces).toHaveLength(1);
        expect(faceRepo.everyConfirmedFace("jane", [], 2, 0)).toEqual({ faces: [], total: 0 });
    });
});

describe("faces for a performer's picture", () => {
    const original = (mediaId: string): void => {
        db.prepare(
            `INSERT OR IGNORE INTO "MediaRoot" ("id", "path", "label", "updatedAt")
             VALUES ('root', '/media', 'Media', CURRENT_TIMESTAMP)`
        ).run();
        db.prepare(
            `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt",
                                      "updatedAt")
             VALUES (?, 'root', ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).run(`file-${mediaId}`, `${mediaId}.mp4`);
        db.prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES (?, ?, ?, 'original')`
        ).run(`link-${mediaId}`, mediaId, `file-${mediaId}`);
        db.prepare(`UPDATE "Media" SET "listable" = 1 WHERE "id" = ?`).run(mediaId);
    };

    it("offers confirmed, sure, large faces first, the largest first and one an item", () => {
        original("a");
        original("b");
        faceRepo.replaceForMedia("a", [
            face(0, 1000, 0.1, { h: 0.3 }),
            face(1, 2000, 0.1, { h: 0.5 }),
            face(2, 3000, 0.5, { h: 0.6, score: 0.6 }),
        ]);
        faceRepo.replaceForMedia("b", [
            face(0, 1000, 0.1, { h: 0.4 }),
            face(1, 2000, 0.1, { h: 0.1 }),
        ]);

        for (const row of [...faces("a"), ...faces("b")]) {
            confirm(row.id, "jane");
        }

        expect(
            faceRepo
                .pictureCandidates(0.7, 0.2, 3)
                .map((row) => [row.mediaId, row.atMs, row.fileId, row.tier])
        ).toEqual([
            // The surest-largest of each item, the larger item's first; too small and too unsure
            // come after, as the last resort.
            ["a", 2000, "file-a", 1],
            ["b", 1000, "file-b", 1],
            ["a", 3000, "file-a", 3],
            ["b", 2000, "file-b", 3],
        ]);
    });

    it("offers a face their standing automatic tag rests on, after the confirmed ones", () => {
        const autoTag = (mediaId: string, state: string): void => {
            db.prepare(
                `INSERT INTO "FaceAutoTag" ("mediaId", "tagId", "faceId", "score", "strongFaces",
                                            "state")
                 VALUES (?, 'jane', ?, 0.8, 2, ?)`
            ).run(mediaId, faces(mediaId)[0].id, state);
        };

        for (const mediaId of ["c", "d"]) {
            db.prepare(
                `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
                 VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
            ).run(mediaId, mediaId);
        }

        for (const mediaId of ["a", "b", "c", "d"]) {
            original(mediaId);
            faceRepo.replaceForMedia(mediaId, [face(0, 1000, 0.1, { h: 0.5 })]);
        }

        confirm(faces("a")[0].id, "jane");
        // Tagged by itself and standing; taken back; only proposed; tagged, then undone.
        autoTag("b", "applied");
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES ('bj', 'b', 'jane', 'user')`
        ).run();
        autoTag("c", "removed");
        autoTag("d", "applied");

        expect(
            faceRepo.pictureCandidates(0.7, 0.2, 3).map((row) => [row.mediaId, row.tier])
        ).toEqual([
            ["a", 1],
            ["b", 2],
        ]);
    });

    it("leaves out unconfirmed faces and items in the trash", () => {
        original("a");
        original("b");
        faceRepo.replaceForMedia("a", [face(0, 1000, 0.1, { h: 0.5 })]);
        faceRepo.replaceForMedia("b", [face(0, 1000, 0.1, { h: 0.5 })]);
        confirm(faces("b")[0].id, "jane");
        db.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = 'b'`).run();

        expect(faceRepo.pictureCandidates(0.7, 0.2, 3)).toEqual([]);
    });
});

describe("corrections stick", () => {
    const tagItem = (mediaId: string, tagId: string): void => {
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES (?, ?, ?, 'user')`
        ).run(`${mediaId}-${tagId}`, mediaId, tagId);
    };

    beforeEach(() => {
        faceRepo.replaceForMedia("a", [face(0, 1000, 0.1), face(1, 1000, 0.6)]);
        confirm(faces("a")[0].id, "jane");
        tagItem("a", "jane");
    });

    it("takes a confirmation away when the item stops carrying the performer", () => {
        db.prepare(`DELETE FROM "MediaTag" WHERE "mediaId" = 'a' AND "tagId" = 'jane'`).run();

        expect(faces("a").map((f) => f.tagId)).toEqual([null, null]);
    });

    it("keeps a confirmation when the item's performers are re-done with them kept", () => {
        tagItem("a", "kim");

        const removed = tagRepo.replaceFacet("a", "performer", ["jane"], {
            userId: null,
            createdById: null,
        });

        expect(removed).toEqual(["kim"]);
        expect(faces("a").map((f) => f.tagId)).toEqual(["jane", null]);
    });

    it("refuses every face of items taken off by hand", () => {
        expect(faceRepo.refuseOnItems(["a"], "kim", "someone")).toBe(2);
        expect(refusals("a")).toEqual([
            { vectorIndex: 0, tagId: "kim" },
            { vectorIndex: 1, tagId: "kim" },
        ]);
    });

    it("carries confirmations and refusals to the tag a performer is merged into", () => {
        refuse(faces("a")[1].id, "jane");

        faceRepo.setNoSingleFace("jane", true, "someone");
        tagRepo.mergeTags("jane", "kim");

        expect(faceRepo.noSingleFace("kim")).toBeDefined();
        expect(faces("a").map((f) => f.tagId)).toEqual(["kim", null]);
        expect(refusals("a")).toEqual([{ vectorIndex: 1, tagId: "kim" }]);
    });
});
