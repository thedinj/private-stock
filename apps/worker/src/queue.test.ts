import Database from "better-sqlite3";
import { initializeDatabase } from "@private-stock/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    HEARTBEAT_INTERVAL_MS,
    abandon,
    subjectGone,
    STALE_CLAIM_MS,
    settledMediaIds,
    claimNext,
    complete,
    enqueue,
    fail,
    reclaimStaleJobs,
    startHeartbeat,
    type JobRow,
} from "./queue.js";

/**
 * Exercised against a real in-memory SQLite database rather than a mock: the behaviour under
 * test *is* the SQL — atomic claiming, the partial unique index, and the datetime arithmetic
 * behind backoff. A mock would prove only that the test matches itself.
 */

let db: Database.Database;

beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
});

/**
 * Jobs reference real media. Foreign keys stay ON here deliberately: a job pointing at a
 * media row that no longer exists is a bug the schema should catch, and it would go unnoticed
 * if the tests ran with constraints disabled.
 */
const givenMedia = (id: string, addedMinutesAgo = 0): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "addedAt", "updatedAt")
         VALUES (?, 'video', datetime('now', ?), CURRENT_TIMESTAMP)`
    ).run(id, `-${addedMinutesAgo} minutes`);

    return id;
};

const jobStateOf = (id: string) =>
    db.prepare(`SELECT "state", "attempts", "availableAt" FROM "Job" WHERE "id" = ?`).get(id) as {
        state: string;
        attempts: number;
        availableAt: string;
    };

describe("enqueue", () => {
    it("does not queue the same work twice while it is still outstanding", () => {
        givenMedia("m1");
        enqueue(db, { kind: "probe", fileId: null, mediaId: "m1" });
        enqueue(db, { kind: "probe", fileId: null, mediaId: "m1" });

        const count = db.prepare(`SELECT count(*) AS n FROM "Job"`).get() as { n: number };
        expect(count.n).toBe(1);
    });

    it("allows the same work again once the earlier job has finished", () => {
        givenMedia("m1");
        enqueue(db, { kind: "probe", mediaId: "m1" });
        const first = claimNext(db, ["probe"], "w1") as JobRow;
        complete(db, first.id);

        // A re-scan must be able to re-probe a file that changed on disk.
        enqueue(db, { kind: "probe", mediaId: "m1" });

        const pending = db
            .prepare(`SELECT count(*) AS n FROM "Job" WHERE "state" = 'pending'`)
            .get() as { n: number };
        expect(pending.n).toBe(1);
    });

    it("keeps jobs of different kinds for the same media separate", () => {
        givenMedia("m1");
        enqueue(db, { kind: "probe", mediaId: "m1" });
        enqueue(db, { kind: "cover", mediaId: "m1" });

        const count = db.prepare(`SELECT count(*) AS n FROM "Job"`).get() as { n: number };
        expect(count.n).toBe(2);
    });
});

describe("claimNext", () => {
    it("never hands the same job to two workers", () => {
        givenMedia("m1");
        enqueue(db, { kind: "probe", mediaId: "m1" });

        const first = claimNext(db, ["probe"], "worker-a");
        const second = claimNext(db, ["probe"], "worker-b");

        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it("respects priority, then age", () => {
        givenMedia("m1");
        givenMedia("m2");
        enqueue(db, { kind: "probe", mediaId: "m1", priority: 200 });
        enqueue(db, { kind: "probe", mediaId: "m2", priority: 10 });

        const claimed = claimNext(db, ["probe"], "w1");
        expect(claimed?.mediaId).toBe("m2");
    });

    it("only claims the kinds it was asked for", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });

        expect(claimNext(db, ["probe"], "w1")).toBeNull();
        expect(claimNext(db, ["transcode"], "w1")).not.toBeNull();
    });

    it("does not claim a job whose backoff has not elapsed", () => {
        givenMedia("m1");
        enqueue(db, {
            kind: "probe",
            mediaId: "m1",
            availableAt: new Date(Date.now() + 60_000),
        });

        expect(claimNext(db, ["probe"], "w1")).toBeNull();
    });

    it("returns null when nothing is queued", () => {
        expect(claimNext(db, ["probe"], "w1")).toBeNull();
    });
});

describe("fail", () => {
    it("schedules a retry with backoff while attempts remain", () => {
        givenMedia("m1");
        enqueue(db, { kind: "probe", mediaId: "m1", maxAttempts: 3 });
        const job = claimNext(db, ["probe"], "w1") as JobRow;

        fail(db, job, new Error("ffmpeg exploded"));

        const after = jobStateOf(job.id);
        expect(after.state).toBe("pending");
        // Backoff pushed it into the future, so it is not immediately re-claimable.
        expect(claimNext(db, ["probe"], "w1")).toBeNull();
    });

    it("dead-letters once attempts are exhausted, so a corrupt file stops retrying", () => {
        givenMedia("m1");
        enqueue(db, { kind: "probe", mediaId: "m1", maxAttempts: 1 });
        const job = claimNext(db, ["probe"], "w1") as JobRow;

        fail(db, job, new Error("not a media file"));

        const after = jobStateOf(job.id);
        expect(after.state).toBe("failed");

        const row = db.prepare(`SELECT "lastError" FROM "Job" WHERE "id" = ?`).get(job.id) as {
            lastError: string;
        };
        expect(row.lastError).toContain("not a media file");
    });

    it("dead-letters a permanent failure on the first attempt", () => {
        givenMedia("m1");
        enqueue(db, { kind: "sprite", mediaId: "m1", maxAttempts: 3 });
        const job = claimNext(db, ["sprite"], "w1") as JobRow;

        fail(db, job, new Error("moov atom not found"), { permanent: true });

        expect(jobStateOf(job.id).state).toBe("failed");
    });
});

describe("reclaimStaleJobs", () => {
    it("returns a job whose worker went away", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;

        // Simulate a killed container: the claim stands but the heartbeat stopped.
        db.prepare(
            `UPDATE "Job" SET "heartbeatAt" = datetime('now', '-10 minutes') WHERE "id" = ?`
        ).run(job.id);

        expect(reclaimStaleJobs(db)).toBe(1);
        expect(jobStateOf(job.id).state).toBe("pending");
        expect(claimNext(db, ["transcode"], "w2")).not.toBeNull();
    });

    it("leaves a job with a fresh heartbeat alone", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        claimNext(db, ["transcode"], "w1");

        expect(reclaimStaleJobs(db)).toBe(0);
    });
});

/**
 * A claim has to outlive the sweep that reclaims abandoned ones.
 *
 * This is the whole reason the ticker exists: only `transcode` reports progress, so every
 * other kind used to sit on a claim it never refreshed. A sprite job decoding a full file or
 * a purge copying between volumes runs past `STALE_CLAIM_MS`, and a reclaimed job is not
 * merely re-queued — for a kind with concurrency above one it is run a second time while the
 * first is still going.
 */
describe("startHeartbeat", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const givenClaimedJob = (): JobRow => {
        givenMedia("m1");
        enqueue(db, { kind: "sprite", mediaId: "m1" });

        return claimNext(db, ["sprite"], "w1") as JobRow;
    };

    const ageHeartbeat = (id: string, seconds: number): void => {
        db.prepare(
            `UPDATE "Job" SET "heartbeatAt" = datetime('now', ? || ' seconds') WHERE "id" = ?`
        ).run(-seconds, id);
    };

    it("keeps a long-running job out of the reclaim sweep", () => {
        vi.useFakeTimers();

        const job = givenClaimedJob();
        const { stop } = startHeartbeat(db, job.id);

        // Older than the stale window, as it would be partway through a long decode.
        ageHeartbeat(job.id, STALE_CLAIM_MS / 1000 + 60);
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        stop();

        expect(reclaimStaleJobs(db)).toBe(0);
    });

    it("stops once the handler has returned, so a lost worker is still recovered", () => {
        vi.useFakeTimers();

        const job = givenClaimedJob();
        startHeartbeat(db, job.id).stop();

        ageHeartbeat(job.id, STALE_CLAIM_MS / 1000 + 60);
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 4);

        expect(reclaimStaleJobs(db)).toBe(1);
    });

    /** Three ticks of slack, so one delayed by a slow share does not cost the job its claim. */
    it("beats several times over within the stale window", () => {
        expect(STALE_CLAIM_MS / HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(3);
    });

    /**
     * Liveness only. `heartbeat` writes `COALESCE(?, "progress")`, so the ticker passing no
     * fraction must not overwrite what a handler like the transcode reported.
     */
    it("does not disturb progress reported by the handler", () => {
        vi.useFakeTimers();

        const job = givenClaimedJob();
        const { stop } = startHeartbeat(db, job.id);

        db.prepare(`UPDATE "Job" SET "progress" = 0.5 WHERE "id" = ?`).run(job.id);
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        stop();

        const row = db.prepare(`SELECT "progress" FROM "Job" WHERE "id" = ?`).get(job.id) as {
            progress: number;
        };

        expect(row.progress).toBe(0.5);
    });
});

/**
 * Cancelling work that has already started (§18.7).
 *
 * The worker cannot be messaged — it is a separate process reached only through this table —
 * so cancellation has to be a state it discovers. It discovers it through the heartbeat,
 * which is already an `UPDATE ... WHERE state = 'claimed'` and therefore already asking the
 * question every few seconds.
 */
describe("cancellation", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const givenClaimedJob = (kind = "transcode"): JobRow => {
        givenMedia("m1");
        enqueue(db, { kind, mediaId: "m1" });

        return claimNext(db, [kind], "w1") as JobRow;
    };

    const cancel = (id: string): void => {
        db.prepare(`UPDATE "Job" SET "state" = 'cancelled' WHERE "id" = ?`).run(id);
    };

    it("aborts the running handler on the next beat", () => {
        vi.useFakeTimers();

        const job = givenClaimedJob();
        const { signal, stop } = startHeartbeat(db, job.id);

        expect(signal.aborted).toBe(false);

        cancel(job.id);
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        stop();

        expect(signal.aborted).toBe(true);
    });

    /**
     * Losing the claim to the reclaim sweep aborts too, and must.
     *
     * The row belongs to whoever claimed it next; a handler that kept working would be a
     * second copy of a job already running elsewhere.
     */
    it("aborts when the claim is reclaimed rather than cancelled", () => {
        vi.useFakeTimers();

        const job = givenClaimedJob();
        const { signal, stop } = startHeartbeat(db, job.id);

        db.prepare(`UPDATE "Job" SET "state" = 'pending' WHERE "id" = ?`).run(job.id);
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        stop();

        expect(signal.aborted).toBe(true);
    });

    /**
     * A handler that ignores the signal and finishes must not undo the cancellation.
     *
     * Otherwise the terminal write is a race: stop a job late enough and it reports `done`,
     * having produced output nobody wanted.
     */
    it("does not let a finished handler resurrect a cancelled job", () => {
        const job = givenClaimedJob();

        cancel(job.id);
        complete(db, job.id);

        expect(jobStateOf(job.id).state).toBe("cancelled");
    });

    it("does not retry or dead-letter a cancelled job", () => {
        const job = givenClaimedJob();

        cancel(job.id);
        fail(db, { ...job, attempts: 1 }, new Error("killed"));
        expect(jobStateOf(job.id).state).toBe("cancelled");

        fail(db, { ...job, attempts: 3 }, new Error("killed"));
        expect(jobStateOf(job.id).state).toBe("cancelled");
    });

    it("frees the item to be queued again, since nothing is outstanding", () => {
        const job = givenClaimedJob();

        cancel(job.id);
        enqueue(db, { kind: "transcode", mediaId: "m1" });

        expect(claimNext(db, ["transcode"], "w2")).not.toBeNull();
    });
});

describe("settledMediaIds", () => {
    it("reports an item whose job was cancelled, so the sweep leaves it alone", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;
        db.prepare(`UPDATE "Job" SET "state" = 'cancelled' WHERE "id" = ?`).run(job.id);

        expect(settledMediaIds(db, "transcode")).toEqual(new Set(["m1"]));
    });

    /** An explicit re-queue overrides the cancellation; nothing else does. */
    it("forgets the cancellation once the work is asked for again", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;
        db.prepare(
            `UPDATE "Job" SET "state" = 'cancelled', "createdAt" = datetime('now', '-1 hour')
              WHERE "id" = ?`
        ).run(job.id);

        enqueue(db, { kind: "transcode", mediaId: "m1" });

        expect(settledMediaIds(db, "transcode")).toEqual(new Set());
    });

    it("does not confuse kinds", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;
        db.prepare(`UPDATE "Job" SET "state" = 'cancelled' WHERE "id" = ?`).run(job.id);

        expect(settledMediaIds(db, "sprite")).toEqual(new Set());
    });

    /**
     * The regression, and the reason this covers `failed` as well as `cancelled`.
     *
     * A transcode is a job kind, not a registry stage, so a failure writes no `MediaStage` row
     * and `needsWork` never sees it. Nothing else remembered, so the five-minute backfill
     * re-queued a file the encoder could not accept, watched it fail three more times, and did
     * it again — permanently, while looking like ordinary activity.
     */
    it("reports an item whose job failed to exhaustion, so the backfill stops retrying it", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;
        db.prepare(`UPDATE "Job" SET "state" = 'failed' WHERE "id" = ?`).run(job.id);

        expect(settledMediaIds(db, "transcode")).toEqual(new Set(["m1"]));
    });

    /** An admin asking again is a new decision, exactly as it is for a cancellation. */
    it("forgets the failure once the work is asked for again", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;
        db.prepare(
            `UPDATE "Job" SET "state" = 'failed', "createdAt" = datetime('now', '-1 hour')
              WHERE "id" = ?`
        ).run(job.id);

        enqueue(db, { kind: "transcode", mediaId: "m1" });

        expect(settledMediaIds(db, "transcode")).toEqual(new Set());
    });

    /**
     * A job still being retried has not settled. Excluding it here would take an item out of
     * the backfill on its first transient failure -- a full disk, a locked file -- which is
     * the opposite of what the retry budget is for.
     */
    it("leaves an item alone while its job is still pending a retry", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        claimNext(db, ["transcode"], "w1");
        db.prepare(`UPDATE "Job" SET "state" = 'pending', "attempts" = 1`).run();

        expect(settledMediaIds(db, "transcode")).toEqual(new Set());
    });

    it("says nothing about an item whose job finished successfully", () => {
        givenMedia("m1");
        enqueue(db, { kind: "transcode", mediaId: "m1" });
        const job = claimNext(db, ["transcode"], "w1") as JobRow;
        complete(db, job.id);

        expect(settledMediaIds(db, "transcode")).toEqual(new Set());
    });
});

/**
 * The throttle's exemption (§7c).
 *
 * Work somebody asked for is not background work, so it may take a slot the throttled limit
 * has already closed. The whole feature rests on the claim query being able to tell the two
 * apart before it picks a row -- which is why `requestedByUserId` is a column and not a key
 * inside `payloadJson`.
 */
describe("claimNext, with a throttled kind", () => {
    const givenUser = (id: string): string => {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES (?, ?, ?, 'x', CURRENT_TIMESTAMP)`
        ).run(id, `${id}@example.test`, id);

        return id;
    };

    it("leaves the sweep's own work alone when its kind is exempt-only", () => {
        givenMedia("m1");
        enqueue(db, { kind: "cover", mediaId: "m1" });

        // `cover` is out of throttled slots: it may only be claimed for requested work, and
        // nobody requested this one.
        expect(claimNext(db, [], "w1", ["cover"])).toBeNull();
    });

    it("claims work somebody asked for from the same closed kind", () => {
        givenMedia("m1");
        givenUser("u1");
        enqueue(db, { kind: "cover", mediaId: "m1", requestedByUserId: "u1" });

        const job = claimNext(db, [], "w1", ["cover"]);

        expect(job?.kind).toBe("cover");
        expect(job?.requestedByUserId).toBe("u1");
    });

    /**
     * The mixed case, which is the one a naive implementation gets wrong: a kind with room
     * takes anything, a kind without room takes only requests, and both lists are consulted
     * by one statement rather than by claiming twice.
     */
    it("takes anything from a kind with room and only requests from one without", () => {
        givenMedia("m1");
        givenMedia("m2");
        givenUser("u1");

        enqueue(db, { kind: "cover", mediaId: "m1", priority: 10 });
        enqueue(db, { kind: "phash", mediaId: "m2", priority: 20, requestedByUserId: "u1" });

        const first = claimNext(db, ["phash"], "w1", ["cover"]);
        // The cover is higher priority and still ineligible: nobody asked for it.
        expect(first?.kind).toBe("phash");

        expect(claimNext(db, ["phash"], "w1", ["cover"])).toBeNull();
    });

    it("claims nothing at all when both lists are empty", () => {
        givenMedia("m1");
        enqueue(db, { kind: "cover", mediaId: "m1" });

        expect(claimNext(db, [], "w1", [])).toBeNull();
    });

    it("still reports no requester for ordinary swept work", () => {
        givenMedia("m1");
        enqueue(db, { kind: "cover", mediaId: "m1" });

        expect(claimNext(db, ["cover"], "w1")?.requestedByUserId).toBeNull();
    });
});

/**
 * The order work comes out in (§7d).
 *
 * The queue and the library used to disagree completely. Jobs came out in `createdAt` order,
 * which is the order files were walked; the grid defaults to newest-first. So a fresh import
 * processed from the end nobody looks at, and in a 4,277-item library the first item with a
 * cover sat at grid position 982 -- twenty screens of blanks, while the database honestly
 * reported two thirds of the covers as generated.
 */
describe("claimNext ordering", () => {
    /**
     * Backdated so the two orderings genuinely disagree.
     *
     * Without this the test proves nothing: `CURRENT_TIMESTAMP` has second granularity, so
     * two jobs queued in a row share a `createdAt`, the old ordering ties, and SQLite resolves
     * the tie from whichever index it read -- which now carries `mediaAddedAt` and so gives
     * the right answer for the wrong reason. Forcing the queue order to be the opposite of
     * the library order is what makes this a test of the `ORDER BY` rather than of the index.
     */
    const givenQueuedAt = (mediaId: string, minutesAgo: number): void => {
        db.prepare(`UPDATE "Job" SET "createdAt" = datetime('now', ?) WHERE "mediaId" = ?`).run(
            `-${minutesAgo} minutes`,
            mediaId
        );
    };

    it("takes the newest item first, because that is what the library shows first", () => {
        givenMedia("old", 60);
        givenMedia("new", 1);
        enqueue(db, { kind: "cover", mediaId: "old" });
        enqueue(db, { kind: "cover", mediaId: "new" });

        // Queue order says "old" first; library order says "new". The library wins.
        givenQueuedAt("old", 30);
        givenQueuedAt("new", 5);

        expect(claimNext(db, ["cover"], "w1")?.mediaId).toBe("new");
        expect(claimNext(db, ["cover"], "w1")?.mediaId).toBe("old");
    });

    /**
     * Priority outranks recency, and must: it says what *kind* of work matters. A sprite for
     * the newest item still waits behind a probe for the oldest, because nothing about that
     * item can be rendered until it has been probed.
     */
    it("lets priority outrank recency", () => {
        givenMedia("old", 60);
        givenMedia("new", 1);
        enqueue(db, { kind: "probe", mediaId: "old", priority: 50 });
        enqueue(db, { kind: "sprite", mediaId: "new", priority: 140 });

        expect(claimNext(db, ["probe", "sprite"], "w1")?.kind).toBe("probe");
    });

    /**
     * The bulk-import case, and the reason `createdAt` survives as the last tiebreak: this
     * library added 4,277 items across 44 seconds and 32 distinct timestamps, so hundreds of
     * items share one. Without a final tiebreak their order is whatever the index returns.
     */
    it("falls back to queue order for items added in the same second", () => {
        givenMedia("a", 5);
        givenMedia("b", 5);
        enqueue(db, { kind: "cover", mediaId: "a" });
        enqueue(db, { kind: "cover", mediaId: "b" });

        // Identical addedAt, so the tiebreak decides: "b" was queued first and goes first,
        // which is only observable because the two are backdated apart.
        givenQueuedAt("b", 30);
        givenQueuedAt("a", 5);

        expect(claimNext(db, ["cover"], "w1")?.mediaId).toBe("b");
        expect(claimNext(db, ["cover"], "w1")?.mediaId).toBe("a");
    });

    /**
     * A whole-library pass has no business preceding the items it is about to compare, and
     * NULLs sort last under DESC, which is exactly that behaviour rather than a coincidence
     * worth relying on silently.
     */
    it("puts library-wide work behind per-item work in the same band", () => {
        givenMedia("m1", 30);
        enqueue(db, { kind: "dupes", priority: 200 });
        enqueue(db, { kind: "transcode", mediaId: "m1", priority: 200 });

        // The library pass was queued first, so queue order would take it first.
        db.prepare(
            `UPDATE "Job" SET "createdAt" = datetime('now', '-30 minutes')
                     WHERE "kind" = 'dupes'`
        ).run();
        givenQueuedAt("m1", 5);

        expect(claimNext(db, ["dupes", "transcode"], "w1")?.kind).toBe("transcode");
        expect(claimNext(db, ["dupes", "transcode"], "w1")?.kind).toBe("dupes");
    });

    /**
     * Copied by `enqueue` itself rather than passed in. A caller that had to remember would
     * eventually be a caller that forgot, and the symptom -- work happening in the wrong
     * order -- is invisible until somebody counts.
     */
    it("copies the ordering key from the item without being asked", () => {
        givenMedia("m1", 7);
        enqueue(db, { kind: "cover", mediaId: "m1" });

        const row = db.prepare(`SELECT "mediaAddedAt" FROM "Job" WHERE "mediaId" = 'm1'`).get() as {
            mediaAddedAt: string | null;
        };
        const media = db.prepare(`SELECT "addedAt" FROM "Media" WHERE "id" = 'm1'`).get() as {
            addedAt: string;
        };

        expect(row.mediaAddedAt).toBe(media.addedAt);
    });

    it("leaves the key null for work that belongs to no item", () => {
        enqueue(db, { kind: "scan", priority: 10 });

        const row = db.prepare(`SELECT "mediaAddedAt" FROM "Job" WHERE "kind" = 'scan'`).get() as {
            mediaAddedAt: string | null;
        };

        expect(row.mediaAddedAt).toBeNull();
    });
});

/**
 * Deferring work so a burst collapses into one pass (§7e).
 *
 * The queue's unique index already collapses duplicate *pending* jobs, which made the dupes
 * job look coalescing when it was not: each pass finished in about ten seconds, the next hash
 * queued another immediately, and it ran again. One import produced 3,599 whole-library
 * passes. Leaving the job pending for a settle window is what turns the index into an actual
 * rate limit.
 */
describe("enqueue with availableAt", () => {
    it("is not claimable until its time comes", () => {
        givenMedia("m1");
        enqueue(db, {
            kind: "dupes",
            availableAt: new Date(Date.now() + 60_000),
        });

        expect(claimNext(db, ["dupes"], "w1")).toBeNull();
    });

    /**
     * The mechanism that does the collapsing. While the deferred job sits pending, every
     * later attempt hits the unique index and adds nothing -- so a thousand hashes finishing
     * inside the window cost one pass, not a thousand.
     */
    it("swallows every later request for the same work while it waits", () => {
        enqueue(db, { kind: "dupes", availableAt: new Date(Date.now() + 60_000) });

        for (let i = 0; i < 50; i += 1) {
            enqueue(db, { kind: "dupes", availableAt: new Date(Date.now() + 60_000) });
        }

        const count = db
            .prepare(`SELECT count(*) AS n FROM "Job" WHERE "kind" = 'dupes'`)
            .get() as {
            n: number;
        };

        expect(count.n).toBe(1);
    });

    /**
     * The one that found the bug.
     *
     * `availableAt` was stored with `toISOString()`, and SQLite compares these columns as
     * text against "YYYY-MM-DD HH:MM:SS". "T" sorts after a space, so an ISO timestamp is
     * greater than the current time for the same instant -- and greater than every later one
     * that day. A deferred job would have sat pending for ever, blocking its own kind through
     * the unique index, which is a far worse failure than the one the deferral was fixing.
     */
    it("becomes claimable once the window has passed", () => {
        enqueue(db, { kind: "dupes", availableAt: new Date(Date.now() - 1_000) });

        expect(claimNext(db, ["dupes"], "w1")?.kind).toBe("dupes");
    });

    it("stores the time in the format the schema compares against, not ISO", () => {
        enqueue(db, { kind: "dupes", availableAt: new Date("2026-09-17T09:00:00.000Z") });

        const row = db.prepare(`SELECT "availableAt" FROM "Job" WHERE "kind" = 'dupes'`).get() as {
            availableAt: string;
        };

        expect(row.availableAt).toBe("2026-09-17 09:00:00");
    });
});

describe("work for an item that has left the library (§10e)", () => {
    const ROOT = "root-1";

    /** An item with its original file, in the given state. */
    const givenItem = (id: string, state: "active" | "trashed" = "active"): string => {
        givenMedia(id);

        if (!db.prepare(`SELECT 1 FROM "MediaRoot" WHERE "id" = ?`).get(ROOT)) {
            db.prepare(
                `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
                 VALUES (?, '/media', 'Media', 1, CURRENT_TIMESTAMP)`
            ).run(ROOT);
        }

        db.prepare(
            `INSERT INTO "MediaFile"
                 ("id", "rootId", "relPath", "size", "mtime", "state", "lastSeenAt", "updatedAt")
             VALUES (?, ?, ?, 1, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).run(`f-${id}`, ROOT, `${id}.mp4`, state);
        db.prepare(
            `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
             VALUES (?, ?, ?, 'original')`
        ).run(`l-${id}`, id, `f-${id}`);

        return id;
    };

    const jobFor = (
        kind: string,
        mediaId: string | null,
        fileId: string | null = null
    ): JobRow => ({
        id: "j1",
        kind,
        mediaId,
        fileId,
        payloadJson: null,
        attempts: 1,
        maxAttempts: 3,
        requestedByUserId: null,
    });

    it("says an item in the library is still there", () => {
        givenItem("m1");

        expect(subjectGone(db, jobFor("probe", "m1", "f-m1"))).toBe(false);
    });

    it("says an item deleted outright is gone", () => {
        expect(subjectGone(db, jobFor("probe", "purged"))).toBe(true);
        expect(subjectGone(db, jobFor("filehash", null, "f-purged"))).toBe(true);
    });

    it("says an item whose original is in the bin is gone", () => {
        givenItem("m1", "trashed");

        expect(subjectGone(db, jobFor("transcode", "m1"))).toBe(true);
    });

    it("never says so for the jobs that move an item's bytes in and out of the bin", () => {
        givenItem("m1", "trashed");

        for (const kind of ["trash", "restore", "purge"]) {
            expect(subjectGone(db, jobFor(kind, "m1", "f-m1"))).toBe(false);
        }
    });

    it("has nothing to say about work that is not for an item", () => {
        expect(subjectGone(db, jobFor("scan", null))).toBe(false);
    });

    it("closes the job as cancelled, not failed, so nothing retries it", () => {
        givenItem("m1");
        enqueue(db, { kind: "probe", fileId: null, mediaId: "m1" });

        const job = claimNext(db, ["probe"], "w1");

        abandon(db, job!.id);

        expect(jobStateOf(job!.id).state).toBe("cancelled");
    });
});
