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

describe("grouping", () => {
    const groupsOf = (mediaId: string) =>
        (
            db
                .prepare(`SELECT "groupId" FROM "Face" WHERE "mediaId" = ? ORDER BY "vectorIndex"`)
                .all(mediaId) as { groupId: string | null }[]
        ).map((row) => row.groupId);

    it("lists items with faces added since a point, oldest first", () => {
        faceRepo.replaceForMedia("a", [face(0, 0, 0.1)]);
        faceRepo.replaceForMedia("b", [face(0, 0, 0.1), face(1, 1000, 0.5)]);

        const all = faceRepo.itemsToGroup(0, 10);

        expect(all.map((item) => [item.mediaId, item.kind])).toEqual([
            ["a", "video"],
            ["b", "video"],
        ]);
        expect(faceRepo.itemsToGroup(all[0].last, 10).map((item) => item.mediaId)).toEqual(["b"]);
        expect(faceRepo.facesToGroup("b").map((f) => f.vectorIndex)).toEqual([0, 1]);
    });

    it("assigns faces to groups and moves a merged group's faces", () => {
        faceRepo.replaceForMedia("a", [face(0, 0, 0.1)]);
        faceRepo.replaceForMedia("b", [face(0, 0, 0.1), face(1, 1000, 0.5)]);

        const [a0] = faceRepo.facesToGroup("a");
        const [b0, b1] = faceRepo.facesToGroup("b");

        faceRepo.applyGroups(
            [
                { id: a0.id, groupId: "old" },
                { id: b1.id, groupId: null },
            ],
            []
        );
        faceRepo.applyGroups([{ id: b0.id, groupId: "new" }], [{ from: "old", to: "new" }]);

        expect(groupsOf("a")).toEqual(["new"]);
        expect(groupsOf("b")).toEqual(["new", null]);

        faceRepo.clearGroups();

        expect([...groupsOf("a"), ...groupsOf("b")]).toEqual([null, null, null]);
    });
});

describe("a performer's faces", () => {
    const ROOT = "root";

    /** Items in the library, each with faces in the groups given and the performers given. */
    const setUp = (items: { id: string; groups: string[]; performers?: string[] }[]): void => {
        db.prepare(
            `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
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
                item.groups.map((_, i) => face(i, i * 1000, 0.1 * i, { eyes: 20 + i }))
            );
            faceRepo.facesToGroup(item.id).forEach((row, i) => {
                db.prepare(`UPDATE "Face" SET "groupId" = ? WHERE "id" = ?`).run(
                    item.groups[i],
                    row.id
                );
            });

            for (const tagId of item.performers ?? []) {
                db.prepare(
                    `INSERT INTO "MediaTag" ("id", "mediaId", "tagId") VALUES (?, ?, ?)`
                ).run(`${item.id}-${tagId}`, item.id, tagId);
            }
        }
    };

    const evidence = (groupId: string) =>
        faceRepo
            .groupEvidence([ROOT], faceRepo.performerGroupIds("jane"))
            .find((row) => row.tagId === "jane" && row.groupId === groupId);

    beforeEach(() => {
        for (const id of ["c", "d", "e"]) {
            db.prepare(
                `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
                 VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
            ).run(id, id);
        }
    });

    it("counts what decides a group, among single-performer items", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"], performers: ["jane"] },
            { id: "c", groups: ["g1"], performers: ["kim"] },
            { id: "d", groups: ["g1"], performers: ["jane", "kim"] },
            { id: "e", groups: ["g1", "g2"] },
        ]);

        expect(evidence("g1")).toMatchObject({
            faceCount: 5,
            itemCount: 5,
            untaggedCount: 2,
            taggedAsThem: 2,
            taggedAsOthers: 1,
            confirmed: 0,
            refused: 0,
        });
        // Nothing of Jane's touches g2.
        expect(evidence("g2")).toBeUndefined();
    });

    it("confirms a group's faces, and a refusal takes them back", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"] },
        ]);

        const shown = [faces("a")[0].id, faces("b")[0].id];
        const how = (mediaId: string) =>
            db.prepare(`SELECT "decidedHow" FROM "Face" WHERE "mediaId" = ?`).pluck().get(mediaId);

        // Only the faces shown are confirmed, and they say so.
        expect(faceRepo.decideGroup("g1", "jane", "confirm", "someone", [shown[1]])).toBe(1);
        expect(how("b")).toBe("shown");
        expect(faceRepo.decideGroup("g1", "jane", "confirm", "someone", shown)).toBe(1);
        expect(evidence("g1")).toMatchObject({ confirmed: 2, refused: 0 });

        faceRepo.decideGroup("g1", "jane", "refuse", "someone", shown);

        // Not a's: it carries her, which nobody was asked about.
        expect(evidence("g1")).toMatchObject({ confirmed: 0, refused: 1 });
        expect(refusals("b")).toEqual([{ vectorIndex: 0, tagId: "jane" }]);
        expect(refusals("a")).toEqual([]);
        // And a later confirm does not override the refusal it was told.
        expect(faceRepo.decideGroup("g1", "jane", "confirm", "someone", shown)).toBe(1);
        expect(faces("b").map((f) => f.tagId)).toEqual([null]);
    });

    it("says how each confirmation and refusal was made", () => {
        setUp([
            { id: "a", groups: ["g1", "g1"] },
            { id: "b", groups: ["g1"] },
        ]);
        const [seen, unseen] = faces("a").map((f) => f.id);

        faceRepo.confirmOnItems("g1", "jane", ["a"], "someone", [seen]);
        faceRepo.refuseOnItem("b", "kim", ["g1"], "someone", [], "item");

        expect(
            db.prepare(`SELECT "id", "decidedHow" FROM "Face" WHERE "mediaId" = 'a'`).all()
        ).toEqual(
            expect.arrayContaining([
                { id: seen, decidedHow: "shown" },
                { id: unseen, decidedHow: "inferred" },
            ])
        );
        expect(db.prepare(`SELECT "how" FROM "FaceRefusal"`).pluck().all()).toEqual(["item"]);
    });

    it("lists untagged items in the groups, without those refused for the performer", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1", "g1"] },
        ]);

        expect(
            faceRepo
                .untaggedInGroups(["g1"], "jane", [ROOT])
                .map((row) => row.mediaId)
                .sort()
        ).toEqual(["b", "c"]);

        faceRepo.refuseOnItem("c", "jane", ["g1"], "someone");

        expect(faceRepo.untaggedInGroups(["g1"], "jane", [ROOT]).map((row) => row.mediaId)).toEqual(
            ["b"]
        );
    });

    it("gives every performer's pairs the same counts their own page does", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"], performers: ["jane"] },
            { id: "c", groups: ["g1", "g2"], performers: ["kim"] },
            { id: "d", groups: ["g2"] },
            { id: "e", groups: ["g3"] },
        ]);
        faceRepo.decideGroup("g3", "kim", "confirm", "someone", [faces("e")[0].id]);

        const pairs = faceRepo.groupEvidence([ROOT]);
        const pair = (tagId: string, groupId: string) =>
            pairs.find((row) => row.tagId === tagId && row.groupId === groupId);

        expect(pair("jane", "g1")).toEqual({
            tagId: "jane",
            ...evidence("g1"),
            // Review › Faces' kind control (§5f): every item here is a video.
            untaggedVideos: evidence("g1").untaggedCount,
            untaggedPhotos: 0,
        });
        expect(pair("kim", "g1")).toMatchObject({ taggedAsThem: 1, taggedAsOthers: 2 });
        expect(pair("kim", "g2")).toMatchObject({ itemCount: 2, untaggedCount: 1 });
        // A confirmed face is a pair with nothing tagged behind it.
        expect(pair("kim", "g3")).toMatchObject({ confirmed: 1, taggedAsThem: 0 });
        expect(pair("jane", "g2")).toBeUndefined();
        expect(faceRepo.groupEvidence([])).toEqual([]);

        // An item whose face was refused for them is decided: nothing left to ask about it.
        faceRepo.refuseOnItem("d", "kim", ["g2"], "someone");

        expect(
            faceRepo
                .groupEvidence([ROOT])
                .find((row) => row.tagId === "kim" && row.groupId === "g2")
        ).toMatchObject({ untaggedCount: 0 });
    });

    it("sizes the groups on enough items", () => {
        setUp([
            { id: "a", groups: ["g1", "g1"] },
            { id: "b", groups: ["g1", "g2"] },
        ]);

        expect(faceRepo.groupSizes([ROOT], 2)).toEqual([
            {
                groupId: "g1",
                faceCount: 3,
                itemCount: 2,
                openItems: 2,
                skippedItems: 0,
                leftItems: 0,
                cohesion: null,
                openVideos: 2,
                openPhotos: 0,
                leftVideos: 0,
                leftPhotos: 0,
            },
        ]);

        // "Can't tell" of a's faces: the group knows how much of it is still open.
        expect(faceRepo.skipFaces("g1", ["a"], "someone")).toBe(2);
        expect(faceRepo.groupSizes([ROOT], 2)[0]).toMatchObject({ openItems: 1, skippedItems: 1 });
        expect(faceRepo.sampleFaces("g1", [ROOT], 10, "open").map((row) => row.mediaId)).toEqual([
            "b",
        ]);
        expect(
            faceRepo
                .groupSizes([ROOT], 1)
                .map((row) => row.groupId)
                .sort()
        ).toEqual(["g1", "g2"]);

        // Review › Faces opens on videos (§5f): a photo's faces are counted and sampled apart.
        db.prepare(`UPDATE "Media" SET "kind" = 'image' WHERE "id" = 'b'`).run();

        expect(faceRepo.groupSizes([ROOT], 2)[0]).toMatchObject({
            openItems: 1,
            openVideos: 0,
            openPhotos: 1,
        });
        expect(faceRepo.sampleFaces("g1", [ROOT], 10, "open", "video")).toEqual([]);
        expect(
            faceRepo.sampleFaces("g1", [ROOT], 10, "open", "image").map((row) => row.mediaId)
        ).toEqual(["b"]);
    });

    it("counts as open only the faces nobody has named or set aside", () => {
        setUp([
            { id: "a", groups: ["g1"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");

        expect(faceRepo.groupSizes([ROOT], 2)[0]).toMatchObject({ itemCount: 3, openItems: 2 });
        expect(
            faceRepo
                .sampleFaces("g1", [ROOT], 10, "open")
                .map((row) => row.mediaId)
                .sort()
        ).toEqual(["b", "c"]);
    });

    it("takes a grab bag's undecided faces out of grouping for good, and dissolves the group", () => {
        setUp([
            { id: "a", groups: ["g1"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        faceRepo.confirmOnItems("g1", "jane", ["c"], "someone");

        expect(faceRepo.scatterGroup("g1", "someone")).toBe(2);
        expect(faceRepo.dissolvedGroups()).toEqual(["g1"]);
        // Never grouped again; the confirmed face stays hers, and in its group.
        expect(faceRepo.facesToGroup("a")).toEqual([]);
        expect(faces("c").map((f) => f.tagId)).toEqual(["jane"]);
        expect(faceRepo.groupSizes([ROOT], 1).map((g) => g.groupId)).toEqual(["g1"]);

        // Found again by a re-run, a face stays out.
        faceRepo.replaceForMedia("a", [face(0, 0, 0)]);
        expect(faceRepo.facesToGroup("a")).toEqual([]);

        faceRepo.forgetDissolved(["g1"]);
        expect(faceRepo.dissolvedGroups()).toEqual([]);
    });

    it("keeps each group's cohesion, replaced whole", () => {
        setUp([
            { id: "a", groups: ["g1"] },
            { id: "b", groups: ["g1"] },
        ]);

        expect(faceRepo.hasGroupStats()).toBe(false);

        faceRepo.replaceGroupStats([{ groupId: "g1", cohesion: 0.48 }]);

        expect(faceRepo.groupSizes([ROOT], 2)[0].cohesion).toBe(0.48);
        expect(faceRepo.hasGroupStats()).toBe(true);
    });

    it("counts what is left of a group of two people once one is named", () => {
        setUp([
            { id: "a", groups: ["g1"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");
        faceRepo.refuseOnItem("b", "jane", ["g1"], "someone");
        faceRepo.refuseOnItem("c", "jane", ["g1"], "someone");

        expect(faceRepo.groupSizes([ROOT], 2)[0]).toMatchObject({ leftItems: 2 });
        expect(
            faceRepo
                .sampleFaces("g1", [ROOT], 10, "left")
                .map((row) => row.mediaId)
                .sort()
        ).toEqual(["b", "c"]);

        // Named in turn, or skipped, they are left over no longer.
        faceRepo.confirmOnItems("g1", "kim", ["b"], "someone");
        faceRepo.skipFaces("g1", ["c"], "someone");

        expect(faceRepo.groupSizes([ROOT], 1)[0]).toMatchObject({ leftItems: 0 });
    });

    it("confirms only the items' faces said to be them, and not a refused one", () => {
        setUp([
            { id: "a", groups: ["g1"] },
            { id: "b", groups: ["g1", "g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        refuse(faces("b")[1].id, "jane");

        expect(faceRepo.confirmOnItems("g1", "jane", ["a", "b"], "someone")).toBe(2);
        expect(faces("a").map((row) => row.tagId)).toEqual(["jane"]);
        expect(faces("b").map((row) => row.tagId)).toEqual(["jane", null]);
        expect(faces("c").map((row) => row.tagId)).toEqual([null]);
    });

    it("counts confirmations and refusals by item, not by face", () => {
        setUp([
            { id: "a", groups: ["g1", "g1", "g1"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");
        faceRepo.refuseOnItem("b", "jane", ["g1"], "someone");
        faceRepo.refuseOnItem("c", "jane", ["g1"], "someone");

        // Three confirmed faces on one item, against two items refused: two to one.
        expect(evidence("g1")).toMatchObject({ confirmed: 1, refused: 2 });
    });

    it("leaves faces set aside, and refusals withdrawn, where they belong", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        faceRepo.skipFaces("g1", ["b"], "someone");
        faceRepo.refuseOnItem("c", "jane", ["g1"], "someone");

        // b is set aside and c refused: nothing left to ask about.
        expect(faceRepo.untaggedInGroups(["g1"], "jane", [ROOT])).toEqual([]);
        expect(evidence("g1")).toMatchObject({ untaggedCount: 0 });

        expect(faceRepo.withdrawRefusals("g1", "jane", ["c"])).toBe(1);
        expect(faceRepo.untaggedInGroups(["g1"], "jane", [ROOT]).map((row) => row.mediaId)).toEqual(
            ["c"]
        );
    });

    it("lists the faces on items already tagged with the performer, to compare with", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1", "g1"], performers: ["jane"] },
        ]);

        // c's second face is the larger, and it is the one shown.
        expect(
            faceRepo.taggedInGroup("g1", "jane", [ROOT], 10).map((row) => [row.mediaId, row.x])
        ).toEqual([
            ["c", 0.1],
            ["a", 0],
        ]);
        expect(faceRepo.taggedInGroup("g1", "jane", [ROOT], 1)).toHaveLength(1);
    });

    it("answers about a performer's own groups as the whole library would", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"], performers: ["jane"] },
            { id: "c", groups: ["g1", "g2"], performers: ["kim"] },
            { id: "d", groups: ["g2"] },
            { id: "e", groups: ["g3"] },
        ]);
        faceRepo.decideGroup("g3", "kim", "confirm", "someone", [faces("e")[0].id]);
        faceRepo.refuseOnItem("d", "kim", ["g2"], "someone");
        faceRepo.replaceAnchors(
            [],
            [
                { faceId: faces("d")[0].id, tagId: "jane", score: 0.7, second: 0.1 },
                // Like her, but barely more than like somebody else.
                { faceId: faces("e")[0].id, tagId: "jane", score: 0.6, second: 0.55 },
            ]
        );

        // Her tags reach g1; kim's tags and his confirmation reach all three; her likeness, g2.
        expect(faceRepo.performerGroupIds("jane")).toEqual(["g1"]);
        expect(faceRepo.performerGroupIds("kim").sort()).toEqual(["g1", "g2", "g3"]);
        expect(faceRepo.likenessGroupIds("jane", 0.45, 0.1)).toEqual(["g2"]);

        const only = ["g2", "g3"];
        const inOnly = <T extends { groupId: string }>(rows: T[]) =>
            rows.filter((row) => only.includes(row.groupId));

        expect(faceRepo.groupEvidence([ROOT], only)).toEqual(
            inOnly(faceRepo.groupEvidence([ROOT]))
        );
        expect(faceRepo.groupSizes([ROOT], 1, only)).toEqual(
            inOnly(faceRepo.groupSizes([ROOT], 1))
        );
        expect(faceRepo.groupLikenesses([ROOT], 0.45, 0.1, only)).toEqual(
            inOnly(faceRepo.groupLikenesses([ROOT], 0.45, 0.1))
        );
        expect(faceRepo.groupRefusals(only)).toEqual(inOnly(faceRepo.groupRefusals()));
        expect(faceRepo.groupEvidence([ROOT], [])).toEqual([]);

        // Counted as `untaggedInGroups` lists them: d's face was refused for kim.
        expect(
            faceRepo.untaggedCounts(
                [
                    { groupId: "g1", tagId: "jane" },
                    { groupId: "g2", tagId: "kim" },
                    { groupId: "g2", tagId: "jane" },
                ],
                [ROOT]
            )
        ).toEqual([
            { groupId: "g1", tagId: "jane", items: 1, videos: 1, photos: 0 },
            { groupId: "g2", tagId: "jane", items: 2, videos: 2, photos: 0 },
        ]);
    });

    it("keeps the refusals by group", () => {
        setUp([{ id: "a", groups: ["g1", "g2"] }]);
        faceRepo.refuseOnItem("a", "jane", ["g2"], "someone");

        expect(faceRepo.groupRefusals()).toEqual([{ groupId: "g2", tagId: "jane" }]);
    });

    it("keeps references and best matches whole, and reads them back", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1"] },
            { id: "c", groups: ["g1"] },
        ]);
        const [fa, fb, fc] = ["a", "b", "c"].map((id) => faces(id)[0].id);

        faceRepo.replaceAnchors(
            [{ tagId: "jane", items: 3, confirmedItems: 0, sharedItems: 3 }],
            [
                { faceId: fa, tagId: "jane", score: 0.7, second: 0.1 },
                { faceId: fb, tagId: "jane", score: 0.6, second: 0.2 },
                // Like her, but barely more than like somebody else.
                { faceId: fc, tagId: "jane", score: 0.6, second: 0.55 },
                { faceId: "gone", tagId: "jane", score: 0.9, second: 0 },
            ]
        );

        expect(faceRepo.anchorOf("jane")).toMatchObject({ items: 3, sharedItems: 3 });
        expect(faceRepo.groupLikenesses([ROOT], 0.45, 0.1)).toEqual([
            { groupId: "g1", tagId: "jane", items: 2 },
        ]);
        expect(
            faceRepo.untaggedLookingLike("jane", [ROOT], 0.45, 0.1).map((row) => row.mediaId)
        ).toEqual(["b"]);
        expect(faceRepo.faceFromTags("jane", [ROOT], 5).map((row) => row.mediaId)).toEqual(["a"]);

        faceRepo.replaceAnchors([], []);

        expect(faceRepo.anchorOf("jane")).toBeUndefined();
    });

    it("finds an item's faces matched to performers it does not carry, not refused", () => {
        setUp([{ id: "a", groups: ["g1", "g1", "g1"], performers: ["kim"] }]);
        const [f0, f1, f2] = faces("a").map((f) => f.id);

        faceRepo.replaceAnchors(
            [],
            [
                { faceId: f0, tagId: "jane", score: 0.6, second: 0.2 },
                { faceId: f1, tagId: "jane", score: 0.7, second: 0.2 },
                // She is tagged on it already.
                { faceId: f2, tagId: "kim", score: 0.8, second: 0.2 },
            ]
        );
        refuse(f0, "jane");

        expect(faceRepo.suspectFaces("a").map((row) => [row.id, row.tagId, row.score])).toEqual([
            [f1, "jane", 0.7],
        ]);
    });

    it("leaves a performer with no single face out of every face question, and back when undone", () => {
        setUp([
            // Kim has no single face; Jane is on screen with her in b.
            { id: "a", groups: ["g1"], performers: ["kim"] },
            { id: "b", groups: ["g1"], performers: ["jane", "kim"] },
            { id: "c", groups: ["g1"], performers: ["jane"] },
        ]);
        faceRepo.confirmOnItems("g1", "kim", ["a"], "someone");

        faceRepo.setNoSingleFace("kim", true, "someone");

        expect(faceRepo.noSingleFace("kim")).toBeDefined();
        // Her confirmation and her tags are evidence about no group...
        expect(faceRepo.groupEvidence([ROOT]).some((row) => row.tagId === "kim")).toBe(false);
        expect(faceRepo.confirmedFaceRefs().some((row) => row.tagId === "kim")).toBe(false);
        expect(faceRepo.taggedFaceRefs(10).some((row) => row.tagId === "kim")).toBe(false);
        // ...and b, with her set aside, is a single-performer item of Jane's.
        expect(evidence("g1")).toMatchObject({ taggedAsThem: 2 });

        faceRepo.setNoSingleFace("kim", false, "someone");

        expect(faceRepo.noSingleFace("kim")).toBeUndefined();
        expect(faceRepo.confirmedFaceRefs().some((row) => row.tagId === "kim")).toBe(true);
        expect(evidence("g1")).toMatchObject({ taggedAsThem: 1 });
    });

    it("finds the faces on each performer's tagged items, not refused, not made by a face", () => {
        setUp([
            { id: "a", groups: ["g1"], performers: ["jane"] },
            { id: "b", groups: ["g1", "g2"], performers: ["jane"] },
        ]);
        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES ('x', 'b', 'kim', 'ai')`
        ).run();
        faceRepo.refuseOnItem("b", "jane", ["g2"], "someone");

        const rows = faceRepo.taggedFaceRefs(10);

        expect(rows.map((row) => [row.tagId, row.mediaId, row.vectorIndex]).sort()).toEqual([
            ["jane", "a", 0],
            ["jane", "b", 0],
        ]);
    });

    it("finds where faces' vectors are, and an item's other faces in a group", () => {
        setUp([{ id: "a", groups: ["g1", "g1", "g2"] }]);

        const ids = faces("a").map((row) => row.id);

        expect(
            faceRepo
                .vectorRefs([ids[0], ids[2], "gone"])
                .map((row) => [row.vectorIndex, row.groupId])
                .sort()
        ).toEqual([
            [0, "g1"],
            [2, "g2"],
        ]);
        expect(faceRepo.itemFacesInGroup("g1", "a", [ROOT], 5)).toHaveLength(2);
        expect(faceRepo.itemFacesInGroup("g1", "a", [], 5)).toEqual([]);
    });

    it("pages every confirmed face, every moment, largest first", () => {
        setUp([
            { id: "a", groups: ["g1", "g1"] },
            { id: "b", groups: ["g2"] },
        ]);
        faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");
        faceRepo.confirmOnItems("g2", "jane", ["b"], "someone");

        const first = faceRepo.everyConfirmedFace("jane", [ROOT], 2, 0);

        expect(first.total).toBe(3);
        expect(first.faces).toHaveLength(2);
        expect(faceRepo.everyConfirmedFace("jane", [ROOT], 2, 2).faces).toHaveLength(1);
        expect(faceRepo.everyConfirmedFace("jane", [], 2, 0)).toEqual({ faces: [], total: 0 });
    });

    it("gathers their confirmed faces across groups, one an item", () => {
        setUp([
            { id: "a", groups: ["g1", "g1"] },
            { id: "b", groups: ["g2"] },
            { id: "c", groups: ["g3"] },
        ]);
        faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");
        faceRepo.confirmOnItems("g2", "jane", ["b"], "someone");

        expect(faceRepo.confirmedFaces("jane", [ROOT], 10).map((row) => row.mediaId)).toEqual([
            "a",
            "b",
        ]);
    });

    it("samples one face an item, largest first, and only from items the viewer can see", () => {
        setUp([
            { id: "a", groups: ["g1", "g1"] },
            { id: "b", groups: ["g1"] },
        ]);

        expect(faceRepo.sampleFaces("g1", [ROOT], 10).map((row) => row.mediaId)).toEqual([
            "a",
            "b",
        ]);
        expect(faceRepo.sampleFaces("g1", [], 10)).toEqual([]);
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
