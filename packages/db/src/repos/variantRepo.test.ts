import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Retention is two sweeps that must not undo each other (§8).
 *
 * The hourly sweep reclaims renditions nobody has watched; the five-minute backfill queues a
 * rendition for anything unplayable that has not got one. Between them sits one rule — an
 * evicted row is remembered — and every test here is about that rule, because without it the
 * pair forms a loop that spends CPU for ever and saves no disk at all.
 */

let db: Database.Database;

// The repo binds to the shared `db` export at import time, so the tests point that at an
// in-memory database rather than the real one.
vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const variantRepo = await import("./variantRepo.js");
const { db: sharedDb } = await import("../db.js");

const MEDIA_A = "11111111-0000-4000-8000-000000000000";
const MEDIA_B = "22222222-0000-4000-8000-000000000000";
const PROFILE = "websafe";

const addMedia = (id: string): void => {
    sharedDb
        .prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
             VALUES (?, 'video', 'Test', CURRENT_TIMESTAMP)`
        )
        .run(id);
};

const addVariant = (mediaId: string): string =>
    variantRepo.upsert({
        mediaId,
        profile: PROFILE,
        relPath: `variants/11/${mediaId}/websafe.mp4`,
        bytes: 1_000,
        ready: true,
    }).id;

/** Backdate a rendition, so "a week ago" does not mean waiting a week. */
const age = (mediaId: string, column: "lastUsedAt" | "createdAt", days: number): void => {
    sharedDb
        .prepare(`UPDATE "Variant" SET "${column}" = datetime('now', ?) WHERE "mediaId" = ?`)
        .run(`-${days} days`, mediaId);
};

beforeEach(() => {
    db = sharedDb as Database.Database;

    db.pragma("foreign_keys = OFF");

    const tables = db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[];

    for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");

    initializeDatabase(db);

    addMedia(MEDIA_A);
    addMedia(MEDIA_B);
});

describe("touchUsed", () => {
    it("records that a rendition was served", () => {
        addVariant(MEDIA_A);

        variantRepo.touchUsed(MEDIA_A, PROFILE);

        expect(variantRepo.findOne(MEDIA_A, PROFILE)?.lastUsedAt).not.toBeNull();
    });

    it("writes at most once an hour, because seeking is many requests", () => {
        addVariant(MEDIA_A);
        variantRepo.touchUsed(MEDIA_A, PROFILE);

        const first = variantRepo.findOne(MEDIA_A, PROFILE)?.lastUsedAt;

        // Backdate by less than the window: a second touch must be a no-op, or dragging the
        // scrubber would be a write per range request on the hot playback path.
        sharedDb
            .prepare(`UPDATE "Variant" SET "lastUsedAt" = datetime('now', '-10 minutes')`)
            .run();

        const backdated = variantRepo.findOne(MEDIA_A, PROFILE)?.lastUsedAt;
        variantRepo.touchUsed(MEDIA_A, PROFILE);

        expect(variantRepo.findOne(MEDIA_A, PROFILE)?.lastUsedAt).toBe(backdated);
        expect(backdated).not.toBe(first);
    });

    it("will not freshen a rendition whose bytes are gone", () => {
        const id = addVariant(MEDIA_A);
        variantRepo.markEvicted(id);

        variantRepo.touchUsed(MEDIA_A, PROFILE);

        // Marking it fresh would hide it from the sweep for another week, for a file that is
        // not there.
        expect(variantRepo.findOne(MEDIA_A, PROFILE)?.lastUsedAt).toBeNull();
    });
});

describe("listExpired", () => {
    it("finds a rendition nobody has watched inside the window", () => {
        addVariant(MEDIA_A);
        variantRepo.touchUsed(MEDIA_A, PROFILE);
        age(MEDIA_A, "lastUsedAt", 9);

        expect(variantRepo.listExpired(7, 10).map((row) => row.mediaId)).toEqual([MEDIA_A]);
    });

    it("leaves one watched inside the window alone", () => {
        addVariant(MEDIA_A);
        variantRepo.touchUsed(MEDIA_A, PROFILE);

        expect(variantRepo.listExpired(7, 10)).toEqual([]);
    });

    it("measures a never-watched rendition from when it was made", () => {
        addVariant(MEDIA_A);

        // Finished an hour ago and never played: not stale, or a transcode completing just as
        // the sweep runs would be deleted before anyone could watch it.
        expect(variantRepo.listExpired(7, 10)).toEqual([]);

        age(MEDIA_A, "createdAt", 9);

        expect(variantRepo.listExpired(7, 10).map((row) => row.mediaId)).toEqual([MEDIA_A]);
    });

    it("ignores one that has already been reclaimed", () => {
        const id = addVariant(MEDIA_A);
        age(MEDIA_A, "createdAt", 30);
        variantRepo.markEvicted(id);

        expect(variantRepo.listExpired(7, 10)).toEqual([]);
    });
});

describe("eviction", () => {
    it("keeps the row, drops the claim to be playable", () => {
        const id = addVariant(MEDIA_A);

        variantRepo.markEvicted(id);

        const row = variantRepo.findOne(MEDIA_A, PROFILE);

        expect(row?.ready).toBeNull();
        expect(row?.bytes).toBeNull();
        expect(row?.evictedAt).not.toBeNull();
    });

    it("tells the backfill which items to leave alone", () => {
        const id = addVariant(MEDIA_A);
        addVariant(MEDIA_B);

        variantRepo.markEvicted(id);

        expect(variantRepo.evictedMediaIds()).toEqual(new Set([MEDIA_A]));
        expect(variantRepo.wasEvicted(MEDIA_A, PROFILE)).toBe(true);
        expect(variantRepo.wasEvicted(MEDIA_B, PROFILE)).toBe(false);
    });

    it("forgets the eviction once the rendition is made again", () => {
        const id = addVariant(MEDIA_A);
        variantRepo.markEvicted(id);

        addVariant(MEDIA_A);

        // Otherwise the backfill keeps avoiding an item that is playable again, and the next
        // sweep believes it has already reclaimed one it has not.
        expect(variantRepo.wasEvicted(MEDIA_A, PROFILE)).toBe(false);
        expect(variantRepo.findOne(MEDIA_A, PROFILE)?.evictedAt).toBeNull();
        expect(variantRepo.evictedMediaIds()).toEqual(new Set());
    });
});

describe("listAny", () => {
    it("returns renditions whatever their state, for the teardown", () => {
        const id = addVariant(MEDIA_A);
        addVariant(MEDIA_B);
        variantRepo.markEvicted(id);

        // Switching transcoding off removes everything, including rows whose bytes have
        // already gone — those are the ones that would otherwise keep an item out of the
        // backfill after the feature was turned back on.
        expect(variantRepo.listAny(50)).toHaveLength(2);
    });
});
