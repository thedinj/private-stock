import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findStage } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Queueing and cancelling from the web process.
 *
 * The behaviour under test is the `WHERE` clause in each statement, so these run against a
 * real database rather than a mock: which rows a cancellation reaches is the entire decision,
 * and a mock would only agree with whatever was written.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const jobRepo = await import("./jobRepo.js");
const { db: sharedDb } = await import("../db.js");

const MEDIA = "aaaaaaaa-0000-4000-8000-000000000001";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;

    initializeDatabase(db);
    // Files and roots too: they outlive a `DELETE FROM "Media"` (the cascade reaches the
    // link, not the file), and the second test to insert the same path hits the unique index
    // rather than the behaviour it meant to check.
    db.exec(
        `DELETE FROM "Job"; DELETE FROM "Media";
         DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "MediaRoot";`
    );

    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, 'video', CURRENT_TIMESTAMP)`
    ).run(MEDIA);
});

const givenJob = (state: string, kind = "transcode", mediaId: string | null = MEDIA): string => {
    const id = `job-${state}-${kind}-${Math.random()}`;

    db.prepare(
        `INSERT INTO "Job" ("id", "kind", "mediaId", "state", "updatedAt")
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, kind, mediaId, state);

    return id;
};

const stateOf = (id: string): string =>
    (db.prepare(`SELECT "state" FROM "Job" WHERE "id" = ?`).get(id) as { state: string }).state;

/** A second, third, ... item, so several jobs of one kind can be outstanding at once. */
const givenMedia = (n: number): string => {
    const id = `aaaaaaaa-0000-4000-8000-00000000900${n}`;
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, 'video', CURRENT_TIMESTAMP)`
    ).run(id);

    return id;
};

describe("cancelTranscode", () => {
    /**
     * A claimed job is the one worth cancelling.
     *
     * Cancelling work that has not started saves nothing; the reason this exists is the hour
     * of NAS CPU already under way, which the worker stops when its next heartbeat finds the
     * row is no longer claimed.
     */
    it("stops a transcode that is already running", () => {
        const claimed = givenJob("claimed");

        expect(jobRepo.cancelTranscode(MEDIA)).toBe(1);
        expect(stateOf(claimed)).toBe("cancelled");
    });

    it("stops one that has not started yet", () => {
        const pending = givenJob("pending");

        expect(jobRepo.cancelTranscode(MEDIA)).toBe(1);
        expect(stateOf(pending)).toBe("cancelled");
    });

    /** Rewriting a finished job would lose the record of how it ended. */
    it("leaves jobs that have already finished alone", () => {
        const done = givenJob("done");
        const failed = givenJob("failed");

        expect(jobRepo.cancelTranscode(MEDIA)).toBe(0);
        expect(stateOf(done)).toBe("done");
        expect(stateOf(failed)).toBe("failed");
    });

    /** The item is still being scanned, hashed and previewed; only the rendition was refused. */
    it("touches nothing but the transcode", () => {
        const sprite = givenJob("claimed", "sprite");

        expect(jobRepo.cancelTranscode(MEDIA)).toBe(0);
        expect(stateOf(sprite)).toBe("claimed");
    });

    it("touches no other item", () => {
        const other = "aaaaaaaa-0000-4000-8000-000000000002";
        db.prepare(
            `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, 'video', CURRENT_TIMESTAMP)`
        ).run(other);
        const theirs = givenJob("claimed", "transcode", other);

        expect(jobRepo.cancelTranscode(MEDIA)).toBe(0);
        expect(stateOf(theirs)).toBe("claimed");
    });
});

/**
 * What the item's ledger reads while a stage is on its way (§7b).
 *
 * The item's detail polls this every few seconds while anything is live, so what it selects
 * and how it finds it both matter.
 */
describe("liveForMedia", () => {
    it("reports waiting work as pending and running work as claimed", () => {
        givenJob("pending", "ocr");
        givenJob("claimed", "cover");

        expect(
            jobRepo
                .liveForMedia(MEDIA, ["ocr", "cover", "preview"])
                .sort((a, b) => a.kind.localeCompare(b.kind))
        ).toEqual([
            { kind: "cover", state: "claimed" },
            { kind: "ocr", state: "pending" },
        ]);
    });

    it("ignores work that has already ended", () => {
        givenJob("done", "ocr");
        givenJob("failed", "cover");
        givenJob("cancelled", "preview");

        expect(jobRepo.liveForMedia(MEDIA, ["ocr", "cover", "preview"])).toEqual([]);
    });

    it("reports only the kinds asked about, and only for this item", () => {
        givenJob("pending", "transcode");
        givenJob("pending", "ocr", givenMedia(1));

        expect(jobRepo.liveForMedia(MEDIA, ["ocr"])).toEqual([]);
    });

    it("asks nothing when there are no kinds to ask about", () => {
        givenJob("pending", "ocr");

        expect(jobRepo.liveForMedia(MEDIA, [])).toEqual([]);
    });

    it("finds its rows through the live-job index rather than by scanning the queue", () => {
        const plan = db
            .prepare(
                `EXPLAIN QUERY PLAN SELECT "kind", "state" FROM "Job"
                  WHERE "kind" IN (?, ?)
                    AND COALESCE("mediaId", '') = ?
                    AND "state" IN ('pending', 'claimed')`
            )
            .all("ocr", "cover", MEDIA) as { detail: string }[];

        expect(plan.map((row) => row.detail).join("\n")).toContain("idx_Job_pending_unique");
    });
});

/**
 * What the processing view reads (§13c).
 *
 * `workerAlive` carries the weight here. Everything else on that page is a number that went
 * up; this is the only thing that answers "and is anything still happening?", which a stalled
 * bar cannot distinguish from a finished one.
 */
describe("queueSummary", () => {
    const beat = (id: string, offsetSeconds: number): void => {
        db.prepare(`UPDATE "Job" SET "heartbeatAt" = datetime('now', ?) WHERE "id" = ?`).run(
            `${offsetSeconds} seconds`,
            id
        );
    };

    it("counts outstanding work by kind, busiest first", () => {
        // Distinct items, because the queue's partial unique index forbids two outstanding
        // jobs of one kind against the same one -- the behaviour tested above.
        givenJob("pending", "cover", givenMedia(1));
        givenJob("pending", "cover", givenMedia(2));
        givenJob("pending", "cover", givenMedia(3));
        givenJob("pending", "sprite", givenMedia(4));
        givenJob("claimed", "sprite", givenMedia(5));

        expect(jobRepo.queueSummary().byKind).toEqual([
            { kind: "cover", pending: 3, claimed: 0 },
            { kind: "sprite", pending: 1, claimed: 1 },
        ]);
    });

    /**
     * Finished work is not outstanding work. Counting it would make the queue look permanently
     * backed up on a library that had simply been running a while.
     */
    it("ignores jobs that are already done or cancelled", () => {
        givenJob("done", "cover", givenMedia(1));
        givenJob("cancelled", "cover", givenMedia(2));
        givenJob("pending", "cover", givenMedia(3));

        expect(jobRepo.queueSummary()).toMatchObject({ pending: 1, claimed: 0 });
    });

    it("counts failures, which are neither outstanding nor finished", () => {
        givenJob("failed", "probe", givenMedia(1));
        givenJob("failed", "probe", givenMedia(2));

        const summary = jobRepo.queueSummary();

        expect(summary.failed).toBe(2);
        expect(summary.byKind).toEqual([]);
    });

    it("does not count a failure that has been tried again since", () => {
        const media = givenMedia(1);
        givenJob("failed", "probe", media);
        givenJob("done", "probe", media);

        expect(jobRepo.queueSummary().failed).toBe(0);
    });

    it("believes the worker is alive when a claim has beaten recently", () => {
        beat(givenJob("claimed", "transcode"), -5);

        expect(jobRepo.queueSummary().workerAlive).toBe(true);
    });

    /**
     * The failure this is here to make visible: a claimed job whose heartbeat stopped is a
     * worker that died holding it. The runner beats every fifteen seconds, so a minute of
     * silence is unambiguous.
     */
    it("does not believe a claim whose heartbeat has stopped", () => {
        beat(givenJob("claimed", "transcode"), -300);

        expect(jobRepo.queueSummary().workerAlive).toBe(false);
    });

    it("does not believe a claim that has never beaten at all", () => {
        givenJob("claimed", "transcode");

        expect(jobRepo.queueSummary().workerAlive).toBe(false);
    });

    /**
     * An idle worker and a dead one both hold no claims, so silence is not evidence. Reporting
     * false here means the view says "idle" rather than accusing a healthy worker of dying.
     */
    it("reports an empty queue as not alive rather than as broken", () => {
        expect(jobRepo.queueSummary()).toEqual({
            pending: 0,
            claimed: 0,
            failed: 0,
            workerAlive: false,
            byKind: [],
        });
    });
});

/**
 * Bringing back a rendition retention reclaimed (§8).
 *
 * The automatic sweep deliberately leaves an evicted item alone, so this is the only path
 * that can queue one — which makes both its `JOIN`s load-bearing rather than defensive.
 */
describe("enqueueTranscode", () => {
    /** Link an original file to an item, which is what the statement goes looking for. */
    const givenOriginal = (mediaId: string, state = "active"): string => {
        const fileId = `file-${mediaId}`;

        db.prepare(
            `INSERT OR IGNORE INTO "MediaRoot" ("id", "path", "label", "updatedAt")
             VALUES ('root-1', '/media/test', 'Test', CURRENT_TIMESTAMP)`
        ).run();

        db.prepare(
            `INSERT INTO "MediaFile"
                 ("id", "rootId", "relPath", "size", "mtime", "state", "lastSeenAt", "updatedAt")
             VALUES (?, 'root-1', ?, 1, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).run(fileId, `${mediaId}.mkv`, state);

        db.prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES (?, ?, ?, 'original')`
        ).run(`link-${mediaId}`, mediaId, fileId);

        return fileId;
    };

    it("queues the item's original file, ahead of the background backlog", () => {
        const fileId = givenOriginal(MEDIA);

        jobRepo.enqueueTranscode(MEDIA);

        const row = db
            .prepare(`SELECT "kind", "fileId", "priority" FROM "Job" WHERE "mediaId" = ?`)
            .get(MEDIA) as { kind: string; fileId: string; priority: number };

        expect(row.kind).toBe("transcode");
        expect(row.fileId).toBe(fileId);
        // Somebody is watching a progress bar; the sweep's backlog is at 200.
        expect(row.priority).toBe(50);
    });

    it("does not queue a second one while the first is still live", () => {
        givenOriginal(MEDIA);

        jobRepo.enqueueTranscode(MEDIA);
        jobRepo.enqueueTranscode(MEDIA);

        // Refreshing a page that will not play yet is the expected behaviour, not an edge
        // case, so this has to be idempotent rather than merely tolerable.
        expect(
            db.prepare(`SELECT count(*) AS "n" FROM "Job" WHERE "mediaId" = ?`).get(MEDIA)
        ).toEqual({ n: 1 });
    });

    it("queues nothing for an item whose original is no longer there", () => {
        givenOriginal(MEDIA, "trashed");

        jobRepo.enqueueTranscode(MEDIA);

        // There is nothing to transcode from. A row naming a file in the bin would be claimed
        // and fail, three times, and then be remembered as a failure.
        expect(
            db.prepare(`SELECT count(*) AS "n" FROM "Job" WHERE "mediaId" = ?`).get(MEDIA)
        ).toEqual({ n: 0 });
    });
});

describe("cancelAllTranscodes", () => {
    it("stops everything queued or running, and nothing else", () => {
        // Separate items: the partial unique index allows one live transcode per item, which
        // is the invariant that makes "queue it again" safe everywhere else.
        const pending = givenJob("pending", "transcode", givenMedia(1));
        const claimed = givenJob("claimed", "transcode", givenMedia(2));
        const done = givenJob("done");
        const otherKind = givenJob("pending", "sprite");

        expect(jobRepo.cancelAllTranscodes()).toBe(2);

        expect(stateOf(pending)).toBe("cancelled");
        expect(stateOf(claimed)).toBe("cancelled");
        // A finished transcode is history, and the sprite queue has nothing to do with this.
        expect(stateOf(done)).toBe("done");
        expect(stateOf(otherKind)).toBe("pending");
    });
});

/**
 * Queue retention (§20).
 *
 * The queue had none, and the real library reached 97,717 rows for 14,181 items. What makes this
 * safe to sweep at all is that nothing reads a succeeded job — `MediaStage` is the record that
 * something was attempted. What makes it dangerous is the two states that *are* read:
 * `settledMediaIds` uses `failed` and `cancelled` to decide what must never be queued again, so a
 * sweep that took those would rediscover an unencodable file every five minutes for ever.
 */
describe("pruning finished jobs", () => {
    /** One pass as the worker runs it, minus the pauses between batches. */
    const prune = (olderThanMinutes: number, limit: number): number =>
        jobRepo.deleteFinishedJobs(
            jobRepo.prunableJobIds(olderThanMinutes, limit),
            olderThanMinutes
        );

    /** Ages a row past the window, since these are inserted with CURRENT_TIMESTAMP. */
    const age = (id: string, minutes: number): void => {
        db.prepare(`UPDATE "Job" SET "updatedAt" = datetime('now', ?) WHERE "id" = ?`).run(
            `-${minutes} minutes`,
            id
        );
    };

    const exists = (id: string): boolean =>
        db.prepare(`SELECT 1 FROM "Job" WHERE "id" = ?`).get(id) !== undefined;

    it("takes a succeeded job once it is past the window", () => {
        const old = givenJob("done", "cover", givenMedia(1));

        age(old, 120);

        expect(prune(60, 100)).toBe(1);
        expect(exists(old)).toBe(false);
    });

    it("leaves a recent one, so the log and the row agree for a while", () => {
        const fresh = givenJob("done", "cover", givenMedia(2));

        expect(prune(60, 100)).toBe(0);
        expect(exists(fresh)).toBe(true);
    });

    it("never takes work that is still to do or being done", () => {
        const pending = givenJob("pending", "cover", givenMedia(3));
        const claimed = givenJob("claimed", "cover", givenMedia(4));

        age(pending, 10_000);
        age(claimed, 10_000);

        expect(prune(60, 100)).toBe(0);
        expect(exists(pending)).toBe(true);
        expect(exists(claimed)).toBe(true);
    });

    /** The load-bearing ones: this is what stops a settled failure being rediscovered. */
    it("keeps failures and cancellations however old", () => {
        const failed = givenJob("failed", "transcode", givenMedia(5));
        const cancelled = givenJob("cancelled", "transcode", givenMedia(6));

        age(failed, 100_000);
        age(cancelled, 100_000);

        expect(prune(60, 100)).toBe(0);
        expect(exists(failed)).toBe(true);
        expect(exists(cancelled)).toBe(true);
    });

    /**
     * The subtle one. `settledMediaIds` treats a failure as settled only when nothing *later*
     * exists for that (kind, mediaId) — so removing a later success would turn a retried item
     * back into a settled failure and silently stop work that is currently allowed.
     */
    it("keeps a success that stands in front of a failure for the same item", () => {
        const media = givenMedia(7);
        const failed = givenJob("failed", "transcode", media);
        const succeeded = givenJob("done", "transcode", media);

        age(failed, 100_000);
        age(succeeded, 50_000);

        expect(prune(60, 100)).toBe(0);
        expect(exists(succeeded)).toBe(true);
    });

    /** A different kind is a different question, and must not be shielded by the first one's. */
    it("still takes a success whose failure belongs to another kind", () => {
        const media = givenMedia(8);
        const failed = givenJob("failed", "transcode", media);
        const succeeded = givenJob("done", "cover", media);

        age(failed, 100_000);
        age(succeeded, 100_000);

        expect(prune(60, 100)).toBe(1);
        expect(exists(succeeded)).toBe(false);
        expect(exists(failed)).toBe(true);
    });

    /** Library-wide jobs carry no mediaId, and `IS` is what makes their nulls compare. */
    it("handles jobs with no item of their own", () => {
        const sweep = givenJob("done", "dupes", null);

        age(sweep, 10_000);

        expect(prune(60, 100)).toBe(1);
        expect(exists(sweep)).toBe(false);
    });

    /** Found with a read and deleted later: anything that changed in between must survive. */
    it("rechecks at delete time, so a row retried or shielded since the read is kept", () => {
        const media = givenMedia(20);
        const succeeded = givenJob("done", "transcode", media);
        const other = givenJob("done", "cover", givenMedia(21));

        age(succeeded, 10_000);
        age(other, 10_000);

        const ids = jobRepo.prunableJobIds(60, 100);
        expect(ids).toEqual(expect.arrayContaining([succeeded, other]));

        // A failure for the same (kind, item) appears after the read, and the other is requeued.
        givenJob("failed", "transcode", media);
        db.prepare(`UPDATE "Job" SET "state" = 'pending' WHERE "id" = ?`).run(other);

        expect(jobRepo.deleteFinishedJobs(ids, 60)).toBe(0);
        expect(exists(succeeded)).toBe(true);
        expect(exists(other)).toBe(true);
    });

    it("stops at the batch size, so one pass cannot be a long write", () => {
        for (let n = 10; n < 16; n += 1) {
            age(givenJob("done", "cover", givenMedia(n)), 10_000);
        }

        expect(prune(60, 4)).toBe(4);
        expect(prune(60, 100)).toBe(2);
    });
});

/**
 * Pausing (§7c "Pausing") hands running background work back to the queue so it stops now and
 * resumes later — without spending an attempt, and without touching what somebody asked for.
 */
describe("releaseBackgroundClaims", () => {
    const attemptsOf = (id: string): number =>
        (db.prepare(`SELECT "attempts" FROM "Job" WHERE "id" = ?`).get(id) as { attempts: number })
            .attempts;

    it("returns background work to the queue with its attempt refunded", () => {
        const sweep = givenJob("claimed", "ocr");
        db.prepare(`UPDATE "Job" SET "attempts" = 1, "maxAttempts" = 1 WHERE "id" = ?`).run(sweep);

        expect(jobRepo.releaseBackgroundClaims()).toBe(1);
        expect(stateOf(sweep)).toBe("pending");
        expect(attemptsOf(sweep)).toBe(0);
    });

    it("leaves requested work and the bin's moves running", () => {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
             VALUES ('u1', 'a@example.com', 'Admin', 'x', 'admin', CURRENT_TIMESTAMP)`
        ).run();
        const asked = givenJob("claimed", "ocrTrial");
        db.prepare(`UPDATE "Job" SET "requestedByUserId" = 'u1' WHERE "id" = ?`).run(asked);
        const move = givenJob("claimed", "trash", null);

        expect(jobRepo.releaseBackgroundClaims()).toBe(0);
        expect(stateOf(asked)).toBe("claimed");
        expect(stateOf(move)).toBe("claimed");
    });
});

describe("standing failures", () => {
    /**
     * The list on the Activity tab: a failure stands until something later is queued for the
     * same kind and item. Old failed rows are kept for the backfill's sake, and listing them
     * would report problems that were fixed long ago.
     */
    it("lists a failure nothing has followed, and drops it once a retry is queued", () => {
        const media = givenMedia(1);
        const failed = givenJob("failed", "cover", media);

        expect(jobRepo.listFailed({ limit: 10 }).map((row) => row.id)).toEqual([failed]);

        givenJob("pending", "cover", media);

        expect(jobRepo.listFailed({ limit: 10 })).toEqual([]);
        expect(jobRepo.findFailed([failed])).toEqual([]);
    });

    it("keeps a failure standing when the later job is for a different item or kind", () => {
        const failed = givenJob("failed", "cover", givenMedia(1));
        givenJob("done", "cover", givenMedia(2));
        givenJob("done", "probe", MEDIA);

        expect(jobRepo.findFailed([failed]).map((row) => row.id)).toEqual([failed]);
    });

    /**
     * A file the probe cannot read fails every later stage too. Those failures are Review ›
     * Unreadable's to list (§10g); here they were three Retry buttons that could only fail again.
     */
    it("leaves out every failure on an item whose probe has settled as unreadable", () => {
        const probe = findStage("probe")!;
        const unreadable = givenMedia(1);
        const readable = givenMedia(2);
        const givenProbe = (mediaId: string, attempts: number): void => {
            db.prepare(
                `INSERT INTO "MediaStage" ("mediaId", "stage", "version", "state", "attempts")
                 VALUES (?, 'probe', ?, 'failed', ?)`
            ).run(mediaId, probe.version, attempts);
        };

        givenProbe(unreadable, probe.maxAttempts!);
        // Still below its limit: about to be tried again, so not settled and still listed.
        givenProbe(readable, probe.maxAttempts! - 1);
        givenJob("failed", "probe", unreadable);
        givenJob("failed", "sprite", unreadable);
        const kept = givenJob("failed", "sprite", readable);
        const library = givenJob("failed", "scan", null);

        expect(
            jobRepo
                .listFailed({ limit: 10 })
                .map((row) => row.id)
                .sort()
        ).toEqual([kept, library].sort());
        expect(jobRepo.failedKinds()).toEqual([
            { kind: "scan", count: 1 },
            { kind: "sprite", count: 1 },
        ]);
        expect(jobRepo.queueSummary().failed).toBe(2);
    });

    it("pages newest first and filters by kind", () => {
        const first = givenJob("failed", "cover", givenMedia(1));
        const second = givenJob("failed", "cover", givenMedia(2));
        givenJob("failed", "probe", givenMedia(3));

        const page = jobRepo.listFailed({ kind: "cover", limit: 1 });

        expect(page.map((row) => row.id)).toEqual([second]);
        expect(
            jobRepo
                .listFailed({ kind: "cover", after: page[0]!.cursor, limit: 5 })
                .map((row) => row.id)
        ).toEqual([first]);
        expect(jobRepo.failedKinds()).toEqual([
            { kind: "cover", count: 2 },
            { kind: "probe", count: 1 },
        ]);
    });

    /**
     * The queue summary counts these on every poll of the processing view, and on the NAS the
     * table scan this replaced read six hundred pages to find seventy failures (§20).
     */
    it("finds them through the failure index and probes one item's rows", () => {
        const explain = (sql: string): string =>
            (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
                .map((row) => row.detail)
                .join("\n");
        const standing = `j."state" = 'failed'
            AND NOT EXISTS (
                SELECT 1 FROM "Job" "later"
                 WHERE "later"."kind" = j."kind"
                   AND "later"."mediaId" IS j."mediaId"
                   AND "later"."rowid" > j."rowid"
            )`;

        const count = explain(`SELECT count(*) FROM "Job" j WHERE ${standing}`);
        const list = explain(
            `SELECT j."id" FROM "Job" j WHERE ${standing} ORDER BY +j."rowid" DESC LIMIT 50`
        );

        for (const plan of [count, list]) {
            expect(plan).toContain("idx_Job_failed");
            expect(plan).toContain("idx_Job_mediaId_kind");
            expect(plan).not.toMatch(/^SCAN j$/m);
        }
    });
});

describe("enqueueKind", () => {
    const queued = (): { availableAt: string; due: number }[] =>
        db
            .prepare(
                `SELECT "availableAt", "availableAt" <= CURRENT_TIMESTAMP AS "due" FROM "Job"
                  WHERE "kind" = 'ocrMatch' AND "state" = 'pending'`
            )
            .all() as { availableAt: string; due: number }[];

    it("queues one job for a burst of requests, held back by the delay", () => {
        jobRepo.enqueueKind("ocrMatch", 150, 15);
        jobRepo.enqueueKind("ocrMatch", 150, 15);
        jobRepo.enqueueKind("ocrMatch", 150, 15);

        const rows = queued();

        expect(rows).toHaveLength(1);
        expect(rows[0].due).toBe(0);
        // The same shape as CURRENT_TIMESTAMP, or the claim's comparison would be textual nonsense.
        expect(rows[0].availableAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    });

    it("is due at once without a delay", () => {
        jobRepo.enqueueKind("ocrMatch", 150);

        expect(queued()).toEqual([expect.objectContaining({ due: 1 })]);
    });

    it("queues nothing while one of the kind is running", () => {
        givenJob("claimed", "ocrMatch", null);
        jobRepo.enqueueKind("ocrMatch", 150, 15);

        expect(queued()).toEqual([]);
    });
});
