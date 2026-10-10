import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Face decisions as acts (§5f "Decisions you can take back"): a press is recorded around its
 * writes, every row it writes points at it, and undoing it takes back exactly those.
 */

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const faceRepo = await import("./faceRepo.js");
const faceDecisionRepo = await import("./faceDecisionRepo.js");
const mentionRepo = await import("./mentionRepo.js");
const tagBatchRepo = await import("./tagBatchRepo.js");
const { db: sharedDb } = await import("../db.js");

let db: Database.Database;

const face = (vectorIndex: number) => ({
    vectorIndex,
    atMs: vectorIndex * 10_000,
    x: 0.1 * vectorIndex,
    y: 0.1,
    w: 0.2,
    h: 0.3,
    eyes: 30,
    score: 0.9,
});

const facesOf = (mediaId: string) =>
    db
        .prepare(
            `SELECT "id", "tagId", "decisionId", "skippedAt", "scatteredAt" FROM "Face"
              WHERE "mediaId" = ? ORDER BY "vectorIndex"`
        )
        .all(mediaId) as {
        id: string;
        tagId: string | null;
        decisionId: string | null;
        skippedAt: string | null;
        scatteredAt: string | null;
    }[];

const refusals = () =>
    db.prepare(`SELECT "faceId", "decisionId" FROM "FaceRefusal" ORDER BY "faceId"`).all() as {
        faceId: string;
        decisionId: string | null;
    }[];

const user = (verdict: "is" | "isNot" | "notOnePerson" | "later", tagId: string | null) => ({
    actor: "user" as const,
    userId: "someone",
    verdict,
    tagId,
    surface: "review" as const,
});

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
        faceRepo.replaceForMedia(id, [face(0), face(1)]);
    }

    db.prepare(`UPDATE "Face" SET "groupId" = 'g1'`).run();

    for (const id of ["jane", "kim"]) {
        db.prepare(
            `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
             VALUES (?, 'performer', ?, ?, CURRENT_TIMESTAMP)`
        ).run(id, id, id);
    }
});

describe("recording a press", () => {
    it("stamps every row the press writes, and counts them", () => {
        const { decisionId } = faceDecisionRepo.record(user("is", "jane"), () => {
            faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");
            faceRepo.refuseOnItem("b", "jane", ["g1"], "someone");
        });

        expect(decisionId).not.toBeNull();
        expect(facesOf("a").map((row) => row.decisionId)).toEqual([decisionId, decisionId]);
        expect(refusals().map((row) => row.decisionId)).toEqual([decisionId, decisionId]);
        expect(faceDecisionRepo.find(decisionId!)).toMatchObject({
            verdict: "is",
            tagName: "jane",
            faceCount: 4,
            itemCount: 2,
        });
    });

    it("leaves nothing behind for a press that wrote nothing, and joins one already under way", () => {
        expect(faceDecisionRepo.record(user("is", "jane"), () => 0).decisionId).toBeNull();

        const outer = faceDecisionRepo.record(user("isNot", "jane"), () =>
            faceDecisionRepo.record(user("isNot", "jane"), () =>
                faceRepo.refuseOnItems(["a"], "jane", "someone")
            )
        );

        expect(outer.result.decisionId).toBe(outer.decisionId);
        expect(db.prepare(`SELECT count(*) FROM "FaceDecision"`).pluck().get()).toBe(1);
    });

    it("keeps the tag batch it made, and the decision through a re-run of the faces stage", () => {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES ('u2', 'u2@example.com', 'U2', 'x', CURRENT_TIMESTAMP)`
        ).run();

        const { decisionId } = faceDecisionRepo.record(user("is", "jane"), () => {
            faceRepo.confirmOnItems("g1", "jane", ["a"], "someone");
            tagBatchRepo.applyAssignments({
                userId: "someone",
                scope: null,
                summary: "jane on 1 item",
                assignments: [{ mediaId: "a", tagId: "jane" }],
            });
        });

        expect(faceDecisionRepo.find(decisionId!)?.tagBatchId).not.toBeNull();

        faceRepo.replaceForMedia("a", [face(0), face(1)]);

        expect(facesOf("a").map((row) => row.decisionId)).toEqual([decisionId, decisionId]);
    });
});

describe("undoing a press", () => {
    it("takes back what it wrote and still holds, and nothing a later press rewrote", () => {
        const first = faceDecisionRepo.record(user("isNot", "jane"), () =>
            faceRepo.refuseOnItems(["a", "b"], "jane", "someone")
        ).decisionId!;
        const second = faceDecisionRepo.record(user("is", "kim"), () =>
            faceRepo.confirmOnItems("g1", "kim", ["b"], "someone")
        ).decisionId!;

        expect(faceDecisionRepo.undo(first, "someone")).toMatchObject({ refusals: 4 });
        expect(refusals()).toEqual([]);
        expect(facesOf("b").map((row) => row.tagId)).toEqual(["kim", "kim"]);
        expect(faceDecisionRepo.find(first)?.undoneAt).not.toBeNull();

        faceDecisionRepo.undo(second, "someone");

        expect(facesOf("b").map((row) => row.tagId)).toEqual([null, null]);
    });

    it("brings back faces set aside, or taken out of grouping", () => {
        db.prepare(`UPDATE "Face" SET "groupId" = 'g2' WHERE "mediaId" = 'b'`).run();

        const later = faceDecisionRepo.record(user("later", null), () =>
            faceRepo.skipFaces("g1", ["a"], "someone")
        ).decisionId!;
        const scattered = faceDecisionRepo.record(user("notOnePerson", null), () =>
            faceRepo.scatterGroup("g2", "someone")
        ).decisionId!;

        expect(facesOf("a").every((row) => row.skippedAt !== null)).toBe(true);
        expect(facesOf("b").every((row) => row.scatteredAt !== null)).toBe(true);

        faceDecisionRepo.undo(later, "someone");
        faceDecisionRepo.undo(scattered, "someone");

        expect(facesOf("a").every((row) => row.skippedAt === null)).toBe(true);
        expect(facesOf("b").every((row) => row.scatteredAt === null)).toBe(true);
    });

    it("withdraws an item refused once the tag is added again", () => {
        faceDecisionRepo.record(user("isNot", "jane"), () => {
            faceRepo.refuseOnItems(["a"], "jane", "someone");
            mentionRepo.refuseItems("jane", ["a"], "someone");
        });

        tagBatchRepo.applyAssignments({
            userId: "someone",
            scope: null,
            summary: "jane on 1 item",
            assignments: [{ mediaId: "a", tagId: "jane" }],
        });

        expect(db.prepare(`SELECT count(*) FROM "ItemRefusal"`).pluck().get()).toBe(0);
        expect(refusals()).toEqual([]);
    });
});

describe("History", () => {
    it("pages decisions newest first, by who made them", () => {
        for (let i = 0; i < 3; i += 1) {
            const tagId = i === 1 ? "kim" : "jane";
            const { decisionId } = faceDecisionRepo.record(user("isNot", tagId), () =>
                faceRepo.refuseOnItems([i === 0 ? "a" : "b"], tagId, "someone")
            );

            db.prepare(
                `UPDATE "FaceDecision" SET "createdAt" = datetime('2026-10-10', '+${i} minutes')
                  WHERE "id" = ?`
            ).run(decisionId);
        }

        const first = faceDecisionRepo.page({ actor: "user", tagId: null, before: null, limit: 2 });
        const rest = faceDecisionRepo.page({
            actor: "user",
            tagId: null,
            before: { createdAt: first[1].createdAt, id: first[1].id },
            limit: 2,
        });

        expect(first).toHaveLength(2);
        expect(rest).toHaveLength(1);
        expect(
            faceDecisionRepo.page({ actor: "app", tagId: null, before: null, limit: 5 })
        ).toEqual([]);
        expect(
            faceDecisionRepo.page({ actor: null, tagId: "kim", before: null, limit: 5 })
        ).toHaveLength(1);
    });
});
