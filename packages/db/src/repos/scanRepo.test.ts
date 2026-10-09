import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Scan runs, and the estimate the progress view measures one against (§13c).
 *
 * `lastCompletedFilesSeen` is the interesting one. A directory walk does not know its own
 * total until it has finished, so the only honest denominator a running scan has is what the
 * same library held last time — and which previous run is chosen decides whether the bar is
 * roughly right or confidently wrong.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const scanRepo = await import("./scanRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000001";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;

    initializeDatabase(db);
    db.exec(`DELETE FROM "Scan"; DELETE FROM "MediaRoot";`);

    for (const [id, label] of [
        [ROOT, "Videos"],
        [OTHER, "Photos"],
    ]) {
        db.prepare(
            `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
             VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`
        ).run(id, `/media/${label}`, label);
    }
});

/** A finished run, backdated so ordering is deterministic rather than same-second. */
const givenFinished = (
    rootId: string,
    filesSeen: number,
    state: "done" | "failed",
    minutesAgo: number
): void => {
    db.prepare(
        `INSERT INTO "Scan" ("id", "rootId", "state", "filesSeen", "startedAt", "finishedAt")
         VALUES (?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP)`
    ).run(`s-${rootId}-${minutesAgo}`, rootId, state, filesSeen, `-${minutesAgo} minutes`);
};

describe("currentRun", () => {
    it("finds nothing when no scan is running", () => {
        givenFinished(ROOT, 100, "done", 10);

        expect(scanRepo.currentRun()).toBeUndefined();
    });

    it("finds the running scan", () => {
        const run = scanRepo.start(ROOT);

        expect(scanRepo.currentRun()?.id).toBe(run.id);
    });

    /**
     * `failStaleRunning` only sweeps rows older than an hour, so a worker killed mid-walk
     * leaves a running row behind for that long. The newest is the one actually live; the
     * stale one would otherwise pin the view to a scan that ended yesterday.
     */
    it("prefers the newest running row when a killed worker left an old one behind", () => {
        db.prepare(
            `INSERT INTO "Scan" ("id", "rootId", "state", "filesSeen", "startedAt")
             VALUES ('stale', ?, 'running', 40, datetime('now', '-50 minutes'))`
        ).run(ROOT);

        const live = scanRepo.start(ROOT);

        expect(scanRepo.currentRun()?.id).toBe(live.id);
    });

    it("closes every running scan at boot, and only old ones from the hourly sweep", () => {
        db.prepare(
            `INSERT INTO "Scan" ("id", "rootId", "state", "filesSeen", "startedAt")
             VALUES ('recent', ?, 'running', 40, datetime('now', '-5 minutes'))`
        ).run(ROOT);

        expect(scanRepo.failStaleRunning()).toBe(0);
        expect(scanRepo.isAnyRunning()).toBe(true);

        expect(scanRepo.failStaleRunning(0)).toBe(1);
        expect(scanRepo.isAnyRunning()).toBe(false);
    });

    it("reports the moved count, which the row carries and the view shows", () => {
        const run = scanRepo.start(ROOT);
        scanRepo.updateCounts(run.id, {
            filesSeen: 10,
            filesAdded: 4,
            filesChanged: 1,
            filesMissing: 0,
            filesMoved: 3,
        });

        expect(scanRepo.currentRun()).toMatchObject({ filesSeen: 10, filesMoved: 3 });
    });
});

describe("the running scan", () => {
    /**
     * Asked on every library poll, and scan history is never pruned: without the partial index
     * each poll read every scan ever run to find the one, or none, still going (§20).
     */
    it("is found through its own index rather than by reading the history", () => {
        for (const sql of [
            `SELECT 1 FROM "Scan" WHERE "state" = 'running' LIMIT 1`,
            `SELECT * FROM "Scan" WHERE "state" = 'running' ORDER BY "startedAt" DESC LIMIT 1`,
        ]) {
            const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
                .map((row) => row.detail)
                .join("\n");

            expect(plan).toContain("idx_Scan_running");
            expect(plan).not.toContain("TEMP B-TREE");
        }
    });

    it("is reported while one runs and not after it ends", () => {
        expect(scanRepo.isAnyRunning()).toBe(false);

        const scan = scanRepo.start(ROOT);

        expect(scanRepo.isAnyRunning()).toBe(true);
        expect(scanRepo.currentRun()?.id).toBe(scan.id);

        scanRepo.fail(scan.id, "stopped");

        expect(scanRepo.isAnyRunning()).toBe(false);
        expect(scanRepo.currentRun()).toBeUndefined();
    });
});

describe("lastCompletedFilesSeen", () => {
    it("has no estimate for a library that has never been scanned", () => {
        expect(scanRepo.lastCompletedFilesSeen(ROOT)).toBeNull();
    });

    it("uses the most recent completed walk", () => {
        givenFinished(ROOT, 3_000, "done", 100);
        givenFinished(ROOT, 4_200, "done", 10);

        expect(scanRepo.lastCompletedFilesSeen(ROOT)).toBe(4_200);
    });

    /**
     * The one that matters. A walk that died a tenth of the way through would otherwise become
     * the estimate, and the next scan's bar would hit 100% almost immediately and stay there —
     * worse than having no bar at all, because it looks like an answer.
     */
    it("ignores a run that failed part way through", () => {
        givenFinished(ROOT, 4_200, "done", 100);
        givenFinished(ROOT, 300, "failed", 10);

        expect(scanRepo.lastCompletedFilesSeen(ROOT)).toBe(4_200);
    });

    it("does not borrow another library's total", () => {
        givenFinished(OTHER, 9_000, "done", 10);

        expect(scanRepo.lastCompletedFilesSeen(ROOT)).toBeNull();
    });
});
