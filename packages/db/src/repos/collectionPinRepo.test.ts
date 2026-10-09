import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The per-viewer pin, against a real database (§14b).
 *
 * The property worth a real table rather than a mock: **no row is a state**. No row means
 * "follow whatever the household offers", a row with `pinned = 1` means "in my sidebar", and a
 * row with `pinned` NULL means "I took it out". Everywhere else in this schema a NULL boolean
 * and a missing row mean the same thing, so this is the one place a reader could reasonably
 * assume wrongly.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const repo = await import("./collectionPinRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADA = "u-ada";
const BEN = "u-ben";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`DELETE FROM "CollectionPin"; DELETE FROM "User";`);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                (?, 'ben@example.test', 'Ben', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA, BEN);
});

describe("the three states", () => {
    it("starts with no opinion at all", () => {
        expect(repo.findPin(ADA, "playlist", "p1")).toBeUndefined();
    });

    it("records a pin", () => {
        repo.setPin(ADA, "playlist", "p1", true);

        expect(repo.findPin(ADA, "playlist", "p1")?.pinned).toBe(1);
    });

    /** The row exists and says no — which is not the same as having no row. */
    it("records a deliberate unpin as a row, not as an absence", () => {
        repo.setPin(ADA, "playlist", "p1", false);

        const row = repo.findPin(ADA, "playlist", "p1");

        expect(row).toBeDefined();
        expect(row?.pinned).toBeNull();
    });

    /** Clearing is a third gesture: back to whatever the household offers. */
    it("removes the row when the decision is cleared", () => {
        repo.setPin(ADA, "playlist", "p1", false);
        repo.setPin(ADA, "playlist", "p1", null);

        expect(repo.findPin(ADA, "playlist", "p1")).toBeUndefined();
    });

    it("replaces an earlier decision rather than failing on the key", () => {
        repo.setPin(ADA, "playlist", "p1", true);
        repo.setPin(ADA, "playlist", "p1", false);

        expect(repo.findPin(ADA, "playlist", "p1")?.pinned).toBeNull();
    });

    it("clears a decision that was never made without complaining", () => {
        expect(() => repo.setPin(ADA, "playlist", "p1", null)).not.toThrow();
    });
});

describe("whose opinion it is", () => {
    it("keeps two people's decisions about one collection apart", () => {
        repo.setPin(ADA, "playlist", "p1", true);
        repo.setPin(BEN, "playlist", "p1", false);

        expect(repo.findPin(ADA, "playlist", "p1")?.pinned).toBe(1);
        expect(repo.findPin(BEN, "playlist", "p1")?.pinned).toBeNull();
    });

    /** A view and a playlist can share an id without sharing a pin. */
    it("keeps the two kinds apart", () => {
        repo.setPin(ADA, "playlist", "same-id", true);

        expect(repo.findPin(ADA, "filter", "same-id")).toBeUndefined();
    });

    it("goes with the account when it is deleted", () => {
        repo.setPin(ADA, "playlist", "p1", true);

        db.prepare(`DELETE FROM "User" WHERE "id" = ?`).run(ADA);

        expect(repo.findPin(ADA, "playlist", "p1")).toBeUndefined();
    });
});

describe("reading them in bulk", () => {
    it("returns one kind, for one person, keyed by collection", () => {
        repo.setPin(ADA, "playlist", "p1", true);
        repo.setPin(ADA, "playlist", "p2", false);
        repo.setPin(ADA, "filter", "f1", true);
        repo.setPin(BEN, "playlist", "p3", true);

        const pins = repo.pinsFor(ADA, "playlist");

        expect([...pins.keys()].sort()).toEqual(["p1", "p2"]);
        expect(pins.get("p1")?.pinned).toBe(1);
        expect(pins.get("p2")?.pinned).toBeNull();
    });

    it("is empty for somebody who has decided nothing", () => {
        expect(repo.pinsFor(BEN, "filter").size).toBe(0);
    });
});

describe("forgetting a deleted collection", () => {
    /**
     * Called when the collection goes. The rows would otherwise be orphans that nothing reads
     * and nothing removes — and a collection recreated with a new id would be unaffected, while
     * anybody who had opted out of the old one keeps a row about something that no longer
     * exists.
     */
    it("removes everybody's opinion of it", () => {
        repo.setPin(ADA, "playlist", "p1", true);
        repo.setPin(BEN, "playlist", "p1", false);
        repo.setPin(ADA, "playlist", "p2", true);

        repo.clearPinsFor("playlist", "p1");

        expect(repo.findPin(ADA, "playlist", "p1")).toBeUndefined();
        expect(repo.findPin(BEN, "playlist", "p1")).toBeUndefined();
        expect(repo.findPin(ADA, "playlist", "p2")?.pinned).toBe(1);
    });

    it("leaves the other kind alone under the same id", () => {
        repo.setPin(ADA, "filter", "shared-id", true);
        repo.setPin(ADA, "playlist", "shared-id", true);

        repo.clearPinsFor("playlist", "shared-id");

        expect(repo.findPin(ADA, "filter", "shared-id")?.pinned).toBe(1);
    });
});
