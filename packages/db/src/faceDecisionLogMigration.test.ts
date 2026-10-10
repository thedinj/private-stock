import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";
import { down, up } from "./migrations/20261010_150000_face_decision_log.js";

/**
 * What was decided before decisions were kept, carried over as decisions (§5f "Decisions you can
 * take back"): grouped by the press that wrote it, each listed and undoable.
 */

let db: Database.Database;

const exec = (sql: string): void => {
    db.exec(sql);
};

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    // As a database was before this migration: no log, refusals by name only.
    down(db);
    db.pragma("foreign_keys = OFF");

    exec(`INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
          VALUES ('u1', 'u1@example.test', 'U1', 'x', CURRENT_TIMESTAMP)`);

    for (const tag of ["jane", "kim"]) {
        exec(`INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
              VALUES ('${tag}', 'performer', '${tag}', '${tag}', CURRENT_TIMESTAMP)`);
    }

    const face = (id: string, extra: string) =>
        exec(`INSERT INTO "Face" ("id", "mediaId", "vectorIndex", "x", "y", "w", "h", "eyes", "score"${extra ? `, ${extra.split("=")[0]}` : ""})
              VALUES ('${id}', 'm-${id}', 0, 0, 0, 1, 1, 1, 1${extra ? `, ${extra.split("=")[1]}` : ""})`);

    // One press: two faces confirmed as jane, one refused, the same second.
    face("c1", "");
    face("c2", "");
    face("r1", "");
    exec(`UPDATE "Face" SET "tagId" = 'jane', "decidedByUserId" = 'u1',
                 "decidedAt" = '2026-10-09 10:00:00', "decidedHow" = 'shown'
           WHERE "id" IN ('c1', 'c2')`);
    exec(`INSERT INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "decidedAt", "how")
          VALUES ('r1', 'jane', 'u1', '2026-10-09 10:00:00', 'shown')`);
    // Another: an untag of kim, its faces and its name refused.
    face("k1", "");
    exec(`INSERT INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "decidedAt", "how")
          VALUES ('k1', 'kim', 'u1', '2026-10-09 11:00:00', 'item')`);
    exec(`INSERT INTO "MentionRefusal" ("tagId", "mediaId", "decidedByUserId", "decidedAt")
          VALUES ('kim', 'm-k1', 'u1', '2026-10-09 11:00:00')`);
    // Can't tell, and not one person.
    face("s1", "");
    exec(`UPDATE "Face" SET "skippedAt" = '2026-10-09 12:00:00', "skippedByUserId" = 'u1'
           WHERE "id" = 's1'`);
    face("x1", "");
    exec(`UPDATE "Face" SET "scatteredAt" = '2026-10-09 13:00:00', "scatteredByUserId" = 'u1'
           WHERE "id" = 'x1'`);
});

const decisions = () =>
    db
        .prepare(
            `SELECT "id", "verdict", "tagId", "surface", "faceCount", "itemCount" FROM "FaceDecision"
              ORDER BY "createdAt"`
        )
        .all() as {
        id: string;
        verdict: string;
        tagId: string | null;
        surface: string;
        faceCount: number;
        itemCount: number;
    }[];

describe("carrying over what was decided before", () => {
    it("makes one decision a press, and points every row at it", () => {
        up(db);

        const made = decisions();

        expect(made.map((d) => [d.verdict, d.tagId, d.faceCount, d.itemCount])).toEqual([
            ["is", "jane", 3, 3],
            ["isNot", "kim", 1, 1],
            ["later", null, 1, 1],
            ["notOnePerson", null, 1, 1],
        ]);
        expect(made.every((d) => d.surface === "earlier")).toBe(true);

        const press = made[0].id;

        expect(
            db.prepare(`SELECT count(*) FROM "Face" WHERE "decisionId" = ?`).pluck().get(press)
        ).toBe(2);
        expect(
            db.prepare(`SELECT "decisionId" FROM "FaceRefusal" WHERE "faceId" = 'r1'`).pluck().get()
        ).toBe(press);
        expect(
            db.prepare(`SELECT "decisionId" FROM "ItemRefusal" WHERE "tagId" = 'kim'`).pluck().get()
        ).toBe(made[1].id);
        expect(
            db
                .prepare(`SELECT count(*) FROM sqlite_master WHERE "name" = 'MentionRefusal'`)
                .pluck()
                .get()
        ).toBe(0);
    });

    it("does it once: running again carries nothing over twice", () => {
        up(db);
        up(db);

        expect(decisions()).toHaveLength(4);
    });
});
