import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";
import { up } from "./migrations/20261010_120000_restore_unticked_refusals.js";

/**
 * Faces left unticked in a taken row are asked about again; a whole group refused, and what was
 * said from an item's page, stay refused (§5f "Unsure, face by face").
 */

let db: Database.Database;

const face = (id: string, groupId: string, tagId: string | null, decidedAt: string | null) =>
    db
        .prepare(
            `INSERT INTO "Face" ("id", "mediaId", "vectorIndex", "x", "y", "w", "h", "eyes", "score",
                                 "groupId", "tagId", "decidedAt")
             VALUES (?, 'm-' || ?, 0, 0, 0, 1, 1, 1, 1, ?, ?, ?)`
        )
        .run(id, id, groupId, tagId, decidedAt);

const refuse = (faceId: string, how: string, decidedAt: string) =>
    db
        .prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how", "decidedAt") VALUES (?, 't1', ?, ?)`
        )
        .run(faceId, how, decidedAt);

const refused = (): string[] =>
    (
        db.prepare(`SELECT "faceId" FROM "FaceRefusal" ORDER BY "faceId"`).all() as {
            faceId: string;
        }[]
    ).map((row) => row.faceId);

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
    db.pragma("foreign_keys = OFF");
});

describe("unticked faces asked about again", () => {
    it("withdraws refusals made with a confirmation in the same group, and keeps the rest", () => {
        const at = "2026-10-09 10:00:00";

        // A taken row: one face confirmed, one unticked, one unseen refused with it.
        face("taken", "g1", "t1", "2026-10-09 10:00:01");
        face("unticked", "g1", null, null);
        face("unseen", "g1", null, null);
        refuse("unticked", "shown", at);
        refuse("unseen", "inferred", at);

        // A whole group refused: nothing confirmed beside it.
        face("whole", "g2", null, null);
        refuse("whole", "shown", at);

        // From an item's page.
        face("item", "g1", null, null);
        refuse("item", "item", at);

        // Before decisions were recorded with how they were made.
        face("older", "g1", null, null);
        refuse("older", "shown", "2026-10-08 10:00:00");

        up(db);

        expect(refused()).toEqual(["item", "older", "whole"]);
    });
});
