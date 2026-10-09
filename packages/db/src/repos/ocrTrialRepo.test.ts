import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The OCR test bench's scratch rows (§5d "Settings and the test bench"). What matters: a new
 * comparison replaces the old one rather than piling up beside it, the job that runs it is
 * queued exactly once, and a trial replaced while it runs is not run twice or resurrected.
 */

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const ocrTrialRepo = await import("./ocrTrialRepo.js");
const { db: sharedDb } = await import("../db.js");

let db: Database.Database;
const USER = "33333333-0000-4000-8000-000000000000";

const sides = (label: string) => [
    { side: "current" as const, settingsJson: JSON.stringify({ which: `current-${label}` }) },
    { side: "candidate" as const, settingsJson: JSON.stringify({ which: `candidate-${label}` }) },
];

const jobs = () =>
    db
        .prepare(
            `SELECT "mediaId", "fileId", "priority", "requestedByUserId" FROM "Job"
              WHERE "kind" = 'ocrTrial'`
        )
        .all();

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    for (const { name } of db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.exec(`
        INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
        VALUES ('${USER}', 'a@example.com', 'Admin', 'x', 'admin', CURRENT_TIMESTAMP);
        INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
        VALUES ('root', '/media', 'Media', 1, CURRENT_TIMESTAMP);
        INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
        VALUES ('m1', 'video', 'One', CURRENT_TIMESTAMP);
        INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
        VALUES ('f1', 'root', 'one.mp4', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role") VALUES ('l1', 'm1', 'f1', 'original');
    `);
});

describe("starting a comparison", () => {
    it("queues the pair and one requested job for the video", () => {
        ocrTrialRepo.replaceForMedia("m1", sides("a"), USER);

        expect(
            ocrTrialRepo
                .listForMediaIds(["m1"])
                .map((row) => [row.side, row.state])
                .sort()
        ).toEqual([
            ["candidate", "pending"],
            ["current", "pending"],
        ]);
        // Requested: somebody is waiting at the bench, so it goes ahead of background work.
        expect(jobs()).toEqual([
            { mediaId: "m1", fileId: "f1", priority: 20, requestedByUserId: USER },
        ]);
    });

    it("replaces the previous comparison rather than adding to it", () => {
        ocrTrialRepo.replaceForMedia("m1", sides("a"), USER);
        ocrTrialRepo.replaceForMedia("m1", sides("b"), USER);

        const rows = ocrTrialRepo.listForMediaIds(["m1"]);

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.settingsJson.includes("-b"))).toBe(true);
        // The job already queued will run the new pair; a second would read it twice.
        expect(jobs()).toHaveLength(1);
    });
});

describe("running a comparison", () => {
    it("runs the current settings first, and each trial once", () => {
        ocrTrialRepo.replaceForMedia("m1", sides("a"), USER);

        const first = ocrTrialRepo.nextPending("m1")!;

        expect(first.side).toBe("current");
        expect(ocrTrialRepo.markRunning(first.id)).toBe(true);
        expect(ocrTrialRepo.markRunning(first.id)).toBe(false);
        expect(ocrTrialRepo.nextPending("m1")!.side).toBe("candidate");
    });

    it("lets a result for a replaced trial fall on the floor", () => {
        ocrTrialRepo.replaceForMedia("m1", sides("a"), USER);
        const stale = ocrTrialRepo.nextPending("m1")!;

        ocrTrialRepo.markRunning(stale.id);
        ocrTrialRepo.replaceForMedia("m1", sides("b"), USER);
        ocrTrialRepo.complete(stale.id, { findingsJson: "[]", framesRead: 6, elapsedMs: 10 });

        // The new pair is untouched and still waiting to run.
        expect(ocrTrialRepo.listForMediaIds(["m1"]).map((row) => row.state)).toEqual([
            "pending",
            "pending",
        ]);
    });

    it("goes when the video goes, or leaves the bench", () => {
        ocrTrialRepo.replaceForMedia("m1", sides("a"), USER);
        ocrTrialRepo.removeForMedia(["m1"]);

        expect(ocrTrialRepo.listForMediaIds(["m1"])).toEqual([]);
    });
});
