import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Review passes and their marks (§14d). The filter they feed is tested with the rest of the
 * library query in `mediaRepo.test.ts`.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const reviewPassRepo = await import("./reviewPassRepo.js");
const { db: sharedDb } = await import("../db.js");

const item = (id: string, rootId: string | null): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "listRootId", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
    ).run(id, rootId);

    return id;
};

const dateOf = (passId: string, mediaId: string): string | undefined =>
    (
        db
            .prepare(`SELECT "reviewedAt" FROM "ReviewMark" WHERE "passId" = ? AND "mediaId" = ?`)
            .get(passId, mediaId) as { reviewedAt: string } | undefined
    )?.reviewedAt;

const backdate = (passId: string, mediaId: string, at: string): void => {
    db.prepare(`UPDATE "ReviewMark" SET "reviewedAt" = ? WHERE "passId" = ? AND "mediaId" = ?`).run(
        at,
        passId,
        mediaId
    );
};

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "ReviewMark"; DELETE FROM "ReviewPass"; DELETE FROM "Media";
        DELETE FROM "MediaRoot"; DELETE FROM "User";
        INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt") VALUES
            ('u1', 'u1@example.test', 'U1', 'x', CURRENT_TIMESTAMP),
            ('u2', 'u2@example.test', 'U2', 'x', CURRENT_TIMESTAMP);
        INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "domain", "updatedAt") VALUES
            ('rc', '/media/c', 'C', 1, 'cellar', CURRENT_TIMESTAMP),
            ('rg', '/media/g', 'G', 1, 'games', CURRENT_TIMESTAMP);
    `);
});

describe("passes", () => {
    it("lists a person's own, per room or all, with their mark counts", () => {
        const players = reviewPassRepo.create("u1", "games", "Players");
        reviewPassRepo.create("u1", "games", "Wins");
        reviewPassRepo.create("u1", "cellar", "Reviewed");
        reviewPassRepo.create("u2", "games", "Players");
        reviewPassRepo.mark(players, [item("g1", "rg"), item("g2", "rg")]);

        expect(
            reviewPassRepo.listForOwner("u1", "games").map(({ name, marks }) => [name, marks])
        ).toEqual([
            ["Players", 2],
            ["Wins", 0],
        ]);
        expect(reviewPassRepo.listForOwner("u1", null).map((pass) => pass.domain)).toEqual([
            "cellar",
            "games",
            "games",
        ]);
    });

    it("is unique per person and room, ignoring case", () => {
        reviewPassRepo.create("u1", "games", "Players");

        expect(() => reviewPassRepo.create("u1", "games", "players")).toThrow(/UNIQUE/);
        expect(reviewPassRepo.findByName("u1", "games", "PLAYERS")?.name).toBe("Players");
        // Somebody else's, and another room's, are other passes.
        expect(() => reviewPassRepo.create("u2", "games", "Players")).not.toThrow();
        expect(() => reviewPassRepo.create("u1", "cellar", "Players")).not.toThrow();
    });

    it("limits the name's length", () => {
        expect(() => reviewPassRepo.create("u1", "games", "x".repeat(61))).toThrow(/CHECK/);
    });

    it("renames, and deletes with its marks", () => {
        const pass = reviewPassRepo.create("u1", "games", "Players");
        const other = reviewPassRepo.create("u1", "games", "Wins");
        reviewPassRepo.mark(pass, [item("g1", "rg"), item("g2", "rg")]);
        reviewPassRepo.mark(other, ["g1"]);

        reviewPassRepo.rename(pass, "Who");
        expect(reviewPassRepo.findById(pass)?.name).toBe("Who");

        expect(reviewPassRepo.remove(pass)).toBe(2);
        expect(reviewPassRepo.findById(pass)).toBeUndefined();
        expect(reviewPassRepo.marksFor("u1", "g1").map((mark) => mark.name)).toEqual(["Wins"]);
    });
});

describe("marks", () => {
    it("keeps the first date when marked again, and can be taken back", () => {
        const pass = reviewPassRepo.create("u1", "games", "Players");
        item("g1", "rg");

        expect(reviewPassRepo.mark(pass, ["g1"])).toBe(1);
        backdate(pass, "g1", "2020-01-01 00:00:00");
        expect(reviewPassRepo.mark(pass, ["g1"])).toBe(0);
        expect(dateOf(pass, "g1")).toBe("2020-01-01 00:00:00");

        expect(reviewPassRepo.unmark(pass, ["g1"])).toBe(1);
        expect(dateOf(pass, "g1")).toBeUndefined();
    });

    it("lists an item's marks for one person only, oldest first", () => {
        const players = reviewPassRepo.create("u1", "games", "Players");
        const wins = reviewPassRepo.create("u1", "games", "Wins");
        const theirs = reviewPassRepo.create("u2", "games", "Players");
        item("g1", "rg");
        reviewPassRepo.mark(players, ["g1"]);
        reviewPassRepo.mark(wins, ["g1"]);
        reviewPassRepo.mark(theirs, ["g1"]);
        backdate(wins, "g1", "2020-01-01 00:00:00");

        expect(reviewPassRepo.marksFor("u1", "g1").map((mark) => mark.passId)).toEqual([
            wins,
            players,
        ]);
    });

    it("reads each item's room", () => {
        item("c1", "rc");
        item("g1", "rg");
        item("gone", null);

        expect(reviewPassRepo.itemDomains(["c1", "g1", "gone"])).toEqual(
            new Map([
                ["c1", "cellar"],
                ["g1", "games"],
            ])
        );
    });
});

describe("carrying marks to a surviving copy (§10c)", () => {
    it("adds what is missing, keeps the earlier date, and leaves the departing copy's", () => {
        const players = reviewPassRepo.create("u1", "games", "Players");
        const wins = reviewPassRepo.create("u1", "games", "Wins");
        const theirs = reviewPassRepo.create("u2", "games", "Kills");
        const early = reviewPassRepo.create("u1", "games", "Early");
        item("from", "rg");
        item("to", "rg");
        reviewPassRepo.mark(players, ["from"]);
        reviewPassRepo.mark(theirs, ["from"]);
        reviewPassRepo.mark(wins, ["from", "to"]);
        reviewPassRepo.mark(early, ["from", "to"]);
        backdate(wins, "from", "2020-01-01 00:00:00");
        backdate(wins, "to", "2026-01-01 00:00:00");
        backdate(early, "to", "2019-01-01 00:00:00");

        // Players and Kills arrive, Wins moves earlier, Early stays: three.
        expect(reviewPassRepo.copyMarks("from", "to")).toBe(3);
        expect(dateOf(players, "to")).toBeDefined();
        expect(dateOf(theirs, "to")).toBeDefined();
        expect(dateOf(wins, "to")).toBe("2020-01-01 00:00:00");
        expect(dateOf(early, "to")).toBe("2019-01-01 00:00:00");
        expect(dateOf(players, "from")).toBeDefined();

        // Again, and nothing moves.
        expect(reviewPassRepo.copyMarks("from", "to")).toBe(0);
    });

    it("carries only passes of the survivor's room", () => {
        const games = reviewPassRepo.create("u1", "games", "Players");
        const cellar = reviewPassRepo.create("u1", "cellar", "Reviewed");
        item("from", "rg");
        item("to", "rc");
        reviewPassRepo.mark(games, ["from"]);
        reviewPassRepo.mark(cellar, ["from"]);

        expect(reviewPassRepo.copyMarks("from", "to")).toBe(1);
        expect(reviewPassRepo.marksFor("u1", "to").map((mark) => mark.passId)).toEqual([cellar]);
    });
});
