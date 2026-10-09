import { needsWork, type StageDefinition, type StageState } from "@private-stock/core";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Processing state (§7b).
 *
 * The centrepiece is the last block: `needsWork` decides in TypeScript and
 * `mediaIdsNeedingStage` decides in SQL, and they have to agree about every combination of
 * version, state and attempt count. If they drift, the sweep selects work the worker then
 * declines to do — a loop that burns queue capacity and never reports an error, which is the
 * same shape of silent failure this table was built to remove.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const stageRepo = await import("./stageRepo.js");
const mediaRepo = await import("./mediaRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";

const stage = (overrides: Partial<StageDefinition> = {}): StageDefinition => ({
    name: "cover",
    version: 1,
    mode: "automatic",
    appliesTo: "all",
    priority: 100,
    maxAttempts: 3,
    needsProbe: false,
    describe: "test",
    ...overrides,
});

const addMedia = (id: string, kind: "image" | "video" = "video"): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, ?, 'Test', CURRENT_TIMESTAMP)`
    ).run(id, kind);

    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, ROOT, `${id}.mp4`);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);
};

const pending = (definition: StageDefinition, limit?: number): string[] =>
    stageRepo.mediaIdsNeedingStage(definition, limit).map((row) => row.id);

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

    for (const table of (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)))) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES (?, '/media/videos', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run(ROOT);
});

describe("recording an outcome", () => {
    it("reports work for an item that has never been processed", () => {
        addMedia("m1");

        expect(pending(stage())).toEqual(["m1"]);
    });

    it("stops reporting work once done", () => {
        addMedia("m1");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });

        expect(pending(stage())).toEqual([]);
    });

    /**
     * The regression this table was built for.
     *
     * A blank image has no perceptual hash; the stage runs, correctly produces nothing, and
     * under the old "does an output row exist" test was indistinguishable from never having
     * run. The sweep re-queued it every five minutes, forever.
     */
    it("leaves an empty result alone", () => {
        addMedia("m1");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "empty" });

        expect(pending(stage())).toEqual([]);
        expect(pending(stage())).toEqual([]);
    });

    it("leaves a skipped item alone", () => {
        addMedia("m1");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "skipped" });

        expect(pending(stage())).toEqual([]);
    });
});

describe("failures", () => {
    it("retries below the limit and stops at it", () => {
        addMedia("m1");

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            expect(pending(stage({ maxAttempts: 3 }))).toEqual(["m1"]);
            stageRepo.record({
                mediaId: "m1",
                stage: "cover",
                version: 1,
                state: "failed",
                detail: "boom",
            });
        }

        // One corrupt file must not occupy the queue indefinitely on a machine with no spare
        // capacity.
        expect(pending(stage({ maxAttempts: 3 }))).toEqual([]);
        expect(stageRepo.find("m1", "cover")?.attempts).toBe(3);
    });

    it("retries forever when the stage asks for it", () => {
        // `maxAttempts: null` becomes a negative sentinel in SQL, because `attempts < NULL`
        // is never true and would silently mean the exact opposite.
        addMedia("m1");

        for (let attempt = 0; attempt < 5; attempt += 1) {
            stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "failed" });
        }

        expect(pending(stage({ maxAttempts: null }))).toEqual(["m1"]);
    });

    it("resets the count after a success", () => {
        // The count exists to abandon work that cannot succeed. A stage that has just
        // succeeded plainly can, so leaving the count would put it one failure from being
        // abandoned for a transient problem that is already over.
        addMedia("m1");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "failed" });
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "failed" });
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });

        expect(stageRepo.find("m1", "cover")?.attempts).toBe(0);
    });

    it("keeps the reason, truncated", () => {
        addMedia("m1");
        stageRepo.record({
            mediaId: "m1",
            stage: "cover",
            version: 1,
            state: "failed",
            detail: "x".repeat(900),
        });

        expect(stageRepo.find("m1", "cover")?.detail).toHaveLength(500);
    });

    /** A file the decoder cannot open fails the same way every time; one try is the answer. */
    it("settles at once when a failure is recorded with a floor", () => {
        addMedia("m1");
        addMedia("m2");

        stageRepo.record({
            mediaId: "m1",
            stage: "cover",
            version: 1,
            state: "failed",
            minimumAttempts: 3,
        });

        // An earlier ordinary failure is not double-counted past the floor, either.
        stageRepo.record({ mediaId: "m2", stage: "cover", version: 1, state: "failed" });
        stageRepo.record({
            mediaId: "m2",
            stage: "cover",
            version: 1,
            state: "failed",
            minimumAttempts: 3,
        });

        expect(pending(stage({ maxAttempts: 3 }))).toEqual([]);
        expect(stageRepo.find("m1", "cover")?.attempts).toBe(3);
        expect(stageRepo.find("m2", "cover")?.attempts).toBe(3);
    });

    /** The half-written download: caught early, settled, then finished. */
    it("offers an item again once its failures are cleared, and leaves its successes", () => {
        addMedia("m1");
        stageRepo.record({
            mediaId: "m1",
            stage: "cover",
            version: 1,
            state: "failed",
            minimumAttempts: 3,
        });
        stageRepo.record({ mediaId: "m1", stage: "sprite", version: 1, state: "done" });

        stageRepo.clearFailures("m1");

        expect(pending(stage({ maxAttempts: 3 }))).toEqual(["m1"]);
        expect(stageRepo.find("m1", "sprite")?.state).toBe("done");
    });
});

describe("recipe versions", () => {
    it("re-runs everything below the current version", () => {
        addMedia("m1");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });

        expect(pending(stage({ version: 1 }))).toEqual([]);
        expect(pending(stage({ version: 2 }))).toEqual(["m1"]);
    });

    it("re-runs an exhausted failure after a bump", () => {
        addMedia("m1");

        for (let attempt = 0; attempt < 5; attempt += 1) {
            stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "failed" });
        }

        expect(pending(stage({ version: 1, maxAttempts: 3 }))).toEqual([]);
        expect(pending(stage({ version: 2, maxAttempts: 3 }))).toEqual(["m1"]);
    });
});

describe("applicability", () => {
    it("offers a video-only stage only videos", () => {
        // Recording `skipped` for every photograph would mean writing 200k rows to say that
        // nothing needs doing.
        addMedia("v1", "video");
        addMedia("i1", "image");

        expect(pending(stage({ appliesTo: "video" }))).toEqual(["v1"]);
        expect(pending(stage({ appliesTo: "image" }))).toEqual(["i1"]);
        expect(pending(stage({ appliesTo: "all" })).sort()).toEqual(["i1", "v1"]);
    });

    it("ignores items whose file is gone", () => {
        addMedia("m1");
        db.prepare(`UPDATE "MediaFile" SET "state" = 'missing'`).run();

        expect(pending(stage())).toEqual([]);
    });

    /**
     * A sprite planned before the probe got a guessed layout and sheets claiming negative tile
     * counts, and a file the probe cannot open failed every rendering stage three times over.
     */
    it("holds a stage that needs the probe until the item is probed", () => {
        addMedia("probed");
        addMedia("unprobed");
        db.prepare(`UPDATE "Media" SET "probedAt" = CURRENT_TIMESTAMP WHERE "id" = 'probed'`).run();

        const gated = stage({ needsProbe: true });

        expect(pending(gated)).toEqual(["probed"]);
        expect(stageRepo.countMediaNeedingStage(gated)).toBe(1);
        expect(pending(stage({ needsProbe: false })).sort()).toEqual(["probed", "unprobed"]);
    });

    /**
     * `embed` reads the sprite sheets of a video and the cover of a photograph (§5e). Offered
     * before those exist, every attempt would fail on missing input and the stage would settle
     * as failed for items that were only early.
     */
    it("holds a stage that requires another until that one has settled", () => {
        addMedia("sprited");
        addMedia("unsprited");
        addMedia("failing");
        addMedia("photo", "image");

        const record = (mediaId: string, name: string, state: StageState, attempts = 1): void => {
            for (let i = 0; i < attempts; i += 1) {
                stageRepo.record({ mediaId, stage: name, version: 1, state });
            }
        };

        record("sprited", "sprite", "done");
        record("failing", "sprite", "failed");

        const gated = stage({ name: "embed", requires: { video: "sprite", image: "cover" } });

        expect(pending(gated)).toEqual(["sprited"]);

        // A prerequisite that has given up has settled: the stage records empty for itself.
        record("failing", "sprite", "failed", 2);
        record("photo", "cover", "empty");

        expect(pending(gated).sort()).toEqual(["failing", "photo", "sprited"]);
        expect(stageRepo.countMediaNeedingStage(gated)).toBe(3);
    });
});

describe("counting what is outstanding", () => {
    /**
     * The number beside a switched-off stage on the admin screen (§7b).
     *
     * It has to select the same population the sweep will: a count that disagreed with the
     * work would put a figure in front of somebody deciding whether to commit their library
     * to a stage, and then quietly do something else. Both queries are built from the same
     * fragments for that reason, and this is what checks the two stay together.
     */
    it("counts exactly what the sweep would queue", () => {
        addMedia("v1", "video");
        addMedia("v2", "video");
        addMedia("i1", "image");

        for (const definition of [stage(), stage({ appliesTo: "video" })]) {
            expect(stageRepo.countMediaNeedingStage(definition)).toBe(pending(definition).length);
        }
    });

    it("stops counting an item once the stage has settled on it", () => {
        addMedia("m1");
        addMedia("m2");

        expect(stageRepo.countMediaNeedingStage(stage())).toBe(2);

        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });
        expect(stageRepo.countMediaNeedingStage(stage())).toBe(1);

        // `empty` is a result, not a gap -- the whole reason the table exists.
        stageRepo.record({ mediaId: "m2", stage: "cover", version: 1, state: "empty" });
        expect(stageRepo.countMediaNeedingStage(stage())).toBe(0);
    });

    it("is not capped by the sweep's batch size", () => {
        // The batch bounds a pass; the count answers "how big is this decision", and a
        // number that stopped at 500 would understate every library worth warning about.
        for (let i = 0; i < 12; i += 1) addMedia(`m${i}`);

        expect(stageRepo.countMediaNeedingStage(stage())).toBe(12);
        expect(pending(stage(), 5)).toHaveLength(5);
    });
});

describe("what is already queued", () => {
    const queue = (mediaId: string, kind: string, state: string): void => {
        db.prepare(
            `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "state", "updatedAt")
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(`j-${mediaId}-${kind}-${state}`, kind, mediaId, `f-${mediaId}`, state);
    };

    /**
     * Enqueuing a queued item again is a no-op, and while a stage drains nearly all it owes is
     * queued: production read the rows of 500 such items every pass to enqueue none (§20).
     */
    it("leaves out an item with a live job for the stage, and nothing else", () => {
        for (const id of ["pending", "claimed", "finished", "otherKind", "none"]) addMedia(id);

        queue("pending", "cover", "pending");
        queue("claimed", "cover", "claimed");
        queue("finished", "cover", "done");
        queue("otherKind", "phash", "pending");

        expect(pending(stage()).sort()).toEqual(["finished", "none", "otherKind"]);
    });

    /** A queued item still owes the stage until its job lands; the admin's number says so. */
    it("still counts it", () => {
        addMedia("m1");
        addMedia("m2");
        queue("m1", "cover", "pending");

        expect(stageRepo.countMediaNeedingStage(stage())).toBe(2);
    });

    it("cuts the batch after ordering, newest first", () => {
        for (let i = 0; i < 6; i += 1) {
            addMedia(`m${i}`);
            db.prepare(`UPDATE "Media" SET "addedAt" = ? WHERE "id" = ?`).run(
                `2026-01-0${i + 1} 00:00:00`,
                `m${i}`
            );
        }

        queue("m5", "cover", "pending");

        expect(pending(stage(), 3)).toEqual(["m4", "m3", "m2"]);
    });

    it("returns the original file of each item", () => {
        addMedia("m1");

        expect(stageRepo.mediaIdsNeedingStage(stage())).toEqual([
            { id: "m1", fileId: "f-m1", kind: "video" },
        ]);
    });
});

/** The sweep's change marks (`stageChangeMarks` in the worker composes them, §20). */
describe("change marks", () => {
    it("moves the item mark when an item arrives, and not when an outcome does", () => {
        addMedia("m1");
        const before = stageRepo.newestItem();

        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });
        expect(stageRepo.newestItem()).toBe(before);

        addMedia("m2");
        expect(stageRepo.newestItem()).toBeGreaterThan(before);
    });

    it("moves an outcome mark only for that stage, state and version", () => {
        addMedia("m1");
        addMedia("m2");
        const probeDone = () => stageRepo.newestOutcome("probe", "done", 1);

        expect(probeDone()).toBe(0);

        stageRepo.record({ mediaId: "m1", stage: "ocr", version: 1, state: "done" });
        stageRepo.record({ mediaId: "m2", stage: "probe", version: 2, state: "done" });
        expect(probeDone()).toBe(0);

        stageRepo.record({ mediaId: "m2", stage: "probe", version: 1, state: "done" });
        const first = probeDone();
        expect(first).toBeGreaterThan(0);

        stageRepo.record({ mediaId: "m1", stage: "probe", version: 1, state: "failed" });
        expect(probeDone()).toBe(first);

        // A failure that turns into a success moves its row into the range it is measured on.
        stageRepo.record({ mediaId: "m1", stage: "probe", version: 1, state: "done" });
        expect(probeDone()).toBeGreaterThan(first);
    });

    it("is one descent of the stage index", () => {
        const plan = (
            db
                .prepare(
                    `EXPLAIN QUERY PLAN SELECT MAX(rowid) FROM "MediaStage"
                      INDEXED BY "idx_MediaStage_stage_state_version"
                      WHERE "stage" = 'probe' AND "state" = 'done' AND "version" = 1`
                )
                .all() as { detail: string }[]
        )
            .map((row) => row.detail)
            .join("\n");

        expect(plan).toContain("SEARCH");
        expect(plan).not.toMatch(/SCAN/);
    });
});

describe("an explicit request", () => {
    const addUser = (): void => {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES ('u1', 'a@b.test', 'A', 'x', CURRENT_TIMESTAMP)`
        ).run();
    };

    const jobsFor = (mediaId: string) =>
        db
            .prepare(
                `SELECT "kind", "state", "priority", "requestedByUserId" FROM "Job"
                  WHERE "mediaId" = ?`
            )
            .all(mediaId);

    it("queues the stage ahead of the sweep, whatever happened last time", () => {
        addMedia("m1");
        addUser();
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "empty" });

        stageRepo.requestStage("m1", stage(), "f-m1", "u1");

        expect(jobsFor("m1")).toEqual([
            { kind: "cover", state: "pending", priority: 10, requestedByUserId: "u1" },
        ]);
    });

    it("keeps the last outcome until the new one replaces it", () => {
        // Deleting it made the ledger read exactly as it did before anyone asked, and hid
        // results that were still there -- the text already read out of a file vanished from
        // its panel for the whole of the new pass.
        addMedia("m1");
        addUser();
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });

        stageRepo.requestStage("m1", stage(), "f-m1", "u1");

        expect(stageRepo.find("m1", "cover")?.state).toBe("done");
    });

    it("starts the attempt counter clean", () => {
        // Someone asking for a reprocess is a new decision, not a retry of a failure.
        addMedia("m1");
        addUser();
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "failed" });
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "failed" });

        stageRepo.requestStage("m1", stage(), "f-m1", "u1");

        expect(stageRepo.find("m1", "cover")?.attempts).toBe(0);
    });

    it("takes over a job the sweep already queued rather than waiting behind it", () => {
        addMedia("m1");
        addUser();
        db.prepare(
            `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "priority", "updatedAt")
             VALUES ('sweep', 'cover', 'm1', 'f-m1', 100, CURRENT_TIMESTAMP)`
        ).run();

        stageRepo.requestStage("m1", stage(), "f-m1", "u1");

        expect(jobsFor("m1")).toEqual([
            { kind: "cover", state: "pending", priority: 10, requestedByUserId: "u1" },
        ]);
    });

    it("queues nothing more while one is already running", () => {
        addMedia("m1");
        addUser();
        db.prepare(
            `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "state", "priority", "updatedAt")
             VALUES ('running', 'cover', 'm1', 'f-m1', 'claimed', 100, CURRENT_TIMESTAMP)`
        ).run();

        stageRepo.requestStage("m1", stage(), "f-m1", "u1");
        stageRepo.requestStage("m1", stage(), "f-m1", "u1");

        expect(jobsFor("m1")).toEqual([
            { kind: "cover", state: "claimed", priority: 100, requestedByUserId: null },
        ]);
    });

    it("records who asked", () => {
        addMedia("m1");
        addUser();

        stageRepo.record({
            mediaId: "m1",
            stage: "ocr",
            version: 1,
            state: "done",
            requestedByUserId: "u1",
        });

        expect(stageRepo.find("m1", "ocr")?.requestedByUserId).toBe("u1");
    });

    it("accepts a stage the registry has never heard of", () => {
        // The stage name is open text rather than a CHECK, so a capability added later needs
        // no table rebuild. This is the property being asserted, not an accident.
        addMedia("m1");

        expect(() =>
            stageRepo.record({ mediaId: "m1", stage: "ocr", version: 1, state: "done" })
        ).not.toThrow();
    });
});

describe("the SQL and the rule agree", () => {
    /**
     * `needsWork` decides in TypeScript; `mediaIdsNeedingStage` decides in SQL. Every
     * combination is checked against both, because a divergence makes the sweep select work
     * the worker then declines to do — which spins the queue without ever erroring.
     */
    const states: StageState[] = ["done", "empty", "failed", "skipped"];

    it.each(
        states.flatMap((state) =>
            [0, 2, 5].flatMap((attempts) =>
                [1, 2].flatMap((recordedVersion) =>
                    [1, 2].flatMap((currentVersion) =>
                        [3, null].map(
                            (maxAttempts) =>
                                [
                                    state,
                                    attempts,
                                    recordedVersion,
                                    currentVersion,
                                    maxAttempts,
                                ] as const
                        )
                    )
                )
            )
        )
    )(
        "state=%s attempts=%i recorded=v%i current=v%i max=%s",
        (state, attempts, recordedVersion, currentVersion, maxAttempts) => {
            addMedia("m1");

            db.prepare(
                `INSERT INTO "MediaStage" ("mediaId", "stage", "version", "state", "attempts")
                 VALUES ('m1', 'cover', ?, ?, ?)`
            ).run(recordedVersion, state, attempts);

            const definition = stage({ version: currentVersion, maxAttempts });

            const bySql = pending(definition).length > 0;
            const byRule = needsWork(definition, { version: recordedVersion, state, attempts });

            expect({ bySql, byRule }).toEqual({ bySql: byRule, byRule });
        }
    );
});

/**
 * The progress view's counts (§13c).
 *
 * The drift guard in the last test is the one that matters, and it is the same shape as the
 * `needsWork` agreement above: `countProcessable` is the *denominator* for the numerator
 * `mediaIdsNeedingStage` produces, and the two decide "which items count" in separate SQL. If
 * they disagree, the bar silently never reaches its own end -- it just stops somewhere short
 * and stays there, with nothing to indicate which of the two is wrong.
 */
describe("summary", () => {
    it("groups by state so settled and failed can be told apart", () => {
        addMedia("m1");
        addMedia("m2");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });
        stageRepo.record({ mediaId: "m2", stage: "cover", version: 1, state: "failed" });

        expect(stageRepo.summary()).toEqual([
            { stage: "cover", state: "done", version: 1, count: 1 },
            { stage: "cover", state: "failed", version: 1, count: 1 },
        ]);
    });

    /**
     * Without the version in the grouping, a stage whose recipe has just been improved reads
     * as fully settled for the entire time the resweep runs.
     */
    it("keeps outcomes from different recipe versions apart", () => {
        addMedia("m1");
        addMedia("m2");
        stageRepo.record({ mediaId: "m1", stage: "cover", version: 1, state: "done" });
        stageRepo.record({ mediaId: "m2", stage: "cover", version: 2, state: "done" });

        expect(stageRepo.summary()).toEqual([
            { stage: "cover", state: "done", version: 1, count: 1 },
            { stage: "cover", state: "done", version: 2, count: 1 },
        ]);
    });

    /**
     * A stage row outlives its item being trashed. Counted, it put `13,209 / 13,028` on the
     * index bar: more done than there is library.
     */
    it("leaves out items the library no longer shows", () => {
        addMedia("m1");
        addMedia("m2");
        addMedia("m3");
        for (const id of ["m1", "m2", "m3"]) {
            stageRepo.record({ mediaId: id, stage: "cover", version: 1, state: "done" });
        }
        stageRepo.record({ mediaId: "m3", stage: "sprite", version: 1, state: "failed" });
        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-m2'`).run();
        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'archived' WHERE "id" = 'f-m3'`).run();

        expect(stageRepo.summary()).toEqual([
            { stage: "cover", state: "done", version: 1, count: 1 },
        ]);
    });

    /**
     * The totals are a tally the schema's triggers keep, not a count (§13c), so the failure to
     * fear is drift: some path that changes a stage row or an item's listability without the
     * tally following. Every path that can is exercised here, in an order that crosses them --
     * an item's rows rewritten while it is unlisted, then restored, then deleted with the
     * cascade -- and after each step the tally must equal counting the rows from scratch.
     */
    it("keeps the tally equal to a count from scratch through every way a row can move", () => {
        const fromScratch = () =>
            sharedDb
                .prepare(
                    `SELECT s."stage", s."state", s."version", count(*) AS "count"
                       FROM "MediaStage" s JOIN "Media" m ON m."id" = s."mediaId"
                      WHERE m."listable" = 1
                      GROUP BY s."stage", s."state", s."version"
                      ORDER BY s."stage", s."state", s."version"`
                )
                .all();
        const steps: [string, () => void][] = [
            [
                "record",
                () => {
                    for (const id of ["m1", "m2", "m3", "m4"]) {
                        stageRepo.record({
                            mediaId: id,
                            stage: "cover",
                            version: 1,
                            state: "done",
                        });
                        stageRepo.record({
                            mediaId: id,
                            stage: "probe",
                            version: 1,
                            state: "done",
                        });
                    }
                },
            ],
            [
                "rewrite",
                () =>
                    stageRepo.record({
                        mediaId: "m1",
                        stage: "cover",
                        version: 1,
                        state: "failed",
                    }),
            ],
            [
                "new version",
                () =>
                    stageRepo.record({ mediaId: "m2", stage: "cover", version: 2, state: "done" }),
            ],
            [
                "trash",
                () =>
                    sharedDb
                        .prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-m3'`)
                        .run(),
            ],
            [
                "rewrite while unlisted",
                () =>
                    stageRepo.record({ mediaId: "m3", stage: "cover", version: 1, state: "empty" }),
            ],
            [
                "restore",
                () =>
                    sharedDb
                        .prepare(`UPDATE "MediaFile" SET "state" = 'active' WHERE "id" = 'f-m3'`)
                        .run(),
            ],
            [
                "archive",
                () =>
                    sharedDb
                        .prepare(`UPDATE "MediaFile" SET "state" = 'archived' WHERE "id" = 'f-m4'`)
                        .run(),
            ],
            [
                "classify as companion",
                () =>
                    sharedDb
                        .prepare(
                            `UPDATE "MediaFile" SET "classification" = 'companion' WHERE "id" = 'f-m2'`
                        )
                        .run(),
            ],
            [
                "clear a stage",
                () =>
                    sharedDb
                        .prepare(
                            `DELETE FROM "MediaStage" WHERE "mediaId" = 'm1' AND "stage" = 'probe'`
                        )
                        .run(),
            ],
            [
                "delete a listable item",
                () => sharedDb.prepare(`DELETE FROM "Media" WHERE "id" = 'm1'`).run(),
            ],
            [
                "delete an unlisted item",
                () => sharedDb.prepare(`DELETE FROM "Media" WHERE "id" = 'm4'`).run(),
            ],
            [
                "unlink the original",
                () => sharedDb.prepare(`DELETE FROM "MediaFileLink" WHERE "id" = 'l-m3'`).run(),
            ],
        ];

        for (const id of ["m1", "m2", "m3", "m4"]) {
            addMedia(id);
        }

        for (const [label, step] of steps) {
            step();

            expect({ label, tally: stageRepo.summary() }).toEqual({ label, tally: fromScratch() });
        }
    });

    it("counts an empty library as nothing rather than as null", () => {
        expect(mediaRepo.countProcessable()).toEqual({
            image: 0,
            video: 0,
            probedImage: 0,
            probedVideo: 0,
        });
    });

    it("counts probed items separately from the library total", () => {
        addMedia("m1");
        addMedia("m2");
        sharedDb
            .prepare(`UPDATE "Media" SET "probedAt" = CURRENT_TIMESTAMP WHERE "id" = 'm1'`)
            .run();

        expect(mediaRepo.countProcessable()).toMatchObject({
            video: 2,
            probedVideo: 1,
            probedImage: 0,
        });
    });

    it("excludes an item whose file is no longer active, as the sweep does", () => {
        addMedia("m1");
        addMedia("m2");
        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-m2'`).run();

        expect(mediaRepo.countProcessable()).toMatchObject({ video: 1 });
    });

    /**
     * The denominator and the numerator must agree about the population, or the bar stops
     * short of its own end forever. Asserted across every kind and both file states rather
     * than on one happy case, because the ways these two queries can diverge are exactly the
     * rows that are unusual.
     */
    it("counts precisely the items the sweep would select", () => {
        addMedia("v1", "video");
        addMedia("v2", "video");
        addMedia("i1", "image");
        sharedDb.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-v2'`).run();

        const counts = mediaRepo.countProcessable();

        expect(counts.video + counts.image).toBe(pending(stage({ appliesTo: "all" })).length);
        expect(counts.video).toBe(pending(stage({ name: "sprite", appliesTo: "video" })).length);
        expect(counts.image).toBe(pending(stage({ name: "ocr", appliesTo: "image" })).length);
    });
});

/**
 * Which settings produced an outcome (§5d "What happens when OCR settings change"). A settings
 * change re-reads nothing by itself, so this is the only way the library knows which items an
 * administrator may want read again.
 */
describe("outcomes produced under older settings", () => {
    const ocr = stage({ name: "ocr", priority: 200 });
    const outcome = (mediaId: string, state: StageState, recipe: string | null) =>
        stageRepo.record({ mediaId, stage: "ocr", version: 1, state, recipe });
    const jobs = () =>
        db
            .prepare(
                `SELECT "mediaId", "priority", "requestedByUserId" FROM "Job"
                  WHERE "kind" = 'ocr' ORDER BY "mediaId"`
            )
            .all() as { mediaId: string; priority: number; requestedByUserId: string | null }[];

    beforeEach(() => {
        for (const id of ["m1", "m2", "m3", "m4"]) addMedia(id);
    });

    it("keeps the recipe of the last real output through a failure", () => {
        outcome("m1", "done", "settings-2");
        outcome("m1", "failed", "settings-3");

        // The text on the item is still what revision 2 produced.
        expect(stageRepo.find("m1", "ocr")?.recipe).toBe("settings-2");
    });

    it("counts settled outcomes from any other revision, or from before revisions", () => {
        outcome("m1", "done", "settings-3");
        outcome("m2", "done", "settings-2");
        outcome("m3", "empty", null);
        outcome("m4", "failed", "settings-1");

        expect(stageRepo.countOutdated("ocr", "settings-3", "settings-0")).toEqual({
            items: 2,
            reviewed: 0,
        });
    });

    it("counts an outcome from before recipes as read under the defaults, which it was", () => {
        // Otherwise every item read before settings existed would look out of date the day
        // they arrived, with nothing having changed.
        outcome("m1", "done", null);

        expect(stageRepo.countOutdated("ocr", "settings-0", "settings-0").items).toBe(0);
        expect(stageRepo.countOutdated("ocr", "settings-1", "settings-0").items).toBe(1);
    });

    it("says how many of them carry text somebody reviewed", () => {
        outcome("m2", "done", "settings-2");
        db.prepare(
            `INSERT INTO "MediaText"
                 ("id", "mediaId", "text", "textNorm", "confidence", "occurrences",
                  "stability", "reviewState")
             VALUES ('t1', 'm2', 'SITE', 'site', 0.9, 3, 0.5, 'confirmed')`
        ).run();

        expect(stageRepo.countOutdated("ocr", "settings-3", "settings-0")).toEqual({
            items: 1,
            reviewed: 1,
        });
    });

    it("queues them as background work, a batch at a time, without repeating any", () => {
        for (const id of ["m1", "m2", "m3", "m4"]) outcome(id, "done", "settings-1");

        const first = stageRepo.queueOutdated(ocr, "settings-2", "settings-0", null, 3);
        const second = stageRepo.queueOutdated(ocr, "settings-2", "settings-0", first.next, 3);

        expect(first).toEqual({ queued: 3, next: "m3" });
        expect(second).toEqual({ queued: 1, next: null });
        // The stage's own priority and nobody's request: it waits behind everything else and
        // respects the working window (§7c).
        expect(jobs()).toEqual(
            ["m1", "m2", "m3", "m4"].map((mediaId) => ({
                mediaId,
                priority: 200,
                requestedByUserId: null,
            }))
        );

        // Asking again while they are still queued adds nothing.
        expect(stageRepo.queueOutdated(ocr, "settings-2", "settings-0", null, 10).queued).toBe(0);
    });
});

describe("settled failures (§10g)", () => {
    const probe = stage({ name: "probe", maxAttempts: 3 });
    const library = { place: "library" as const, rootIds: [ROOT] };
    const trash = { place: "trash" as const, rootIds: [ROOT] };

    const fail = (mediaId: string, attempts = 3, version = 1): void => {
        stageRepo.record({ mediaId, stage: "probe", version, state: "failed", detail: "bad" });
        sharedDb
            .prepare(
                `UPDATE "MediaStage" SET "attempts" = ? WHERE "mediaId" = ? AND "stage" = 'probe'`
            )
            .run(attempts, mediaId);
    };

    const sized = (mediaId: string, bytes: number): void => {
        sharedDb
            .prepare(`UPDATE "MediaFile" SET "size" = ? WHERE "id" = ?`)
            .run(bytes, `f-${mediaId}`);
    };

    /** Moves an item to the trash as the service does: the file trashed, an open entry for it. */
    const trashed = (mediaId: string, options: { moved?: boolean; twin?: boolean } = {}): void => {
        sharedDb.pragma("foreign_keys = OFF");
        sharedDb
            .prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = ?`)
            .run(`f-${mediaId}`);
        sharedDb
            .prepare(
                `INSERT INTO "TrashEntry"
                     ("id", "mediaId", "fileId", "rootId", "relPath", "trashRelPath", "bytes",
                      "deletedById", "purgeAfter", "movedAt", "twinFileId")
                 VALUES (?, ?, ?, ?, ?, ?, 1, 'u1', CURRENT_TIMESTAMP, ?, ?)`
            )
            .run(
                `t-${mediaId}`,
                mediaId,
                `f-${mediaId}`,
                ROOT,
                `${mediaId}.mp4`,
                `trash/${mediaId}.mp4`,
                options.moved === false ? null : "2026-10-01 00:00:00",
                options.twin ? "f-other" : null
            );
        sharedDb.pragma("foreign_keys = ON");
    };

    const ids = (filter: stageRepo.SettledFailureFilter): string[] =>
        stageRepo.listSettledFailures(probe, filter, null, 50).rows.map((row) => row.mediaId);

    it("lists a failure that is out of attempts, and not one still being retried", () => {
        addMedia("settled");
        addMedia("retrying");
        fail("settled", 3);
        fail("retrying", 1);

        expect(ids(library)).toEqual(["settled"]);
        expect(stageRepo.summarizeSettledFailures(probe, library)).toEqual({ count: 1, bytes: 1 });
    });

    it("leaves out a failure from an older recipe, which the sweep is about to redo", () => {
        addMedia("m1");
        fail("m1", 3, 1);

        expect(ids(library)).toEqual(["m1"]);
        expect(
            stageRepo.listSettledFailures(stage({ name: "probe", version: 2 }), library, null, 50)
                .rows
        ).toEqual([]);
    });

    it("never lists a stage that does not stop retrying", () => {
        addMedia("m1");
        fail("m1", 50);

        expect(
            stageRepo.listSettledFailures(
                stage({ name: "probe", maxAttempts: null }),
                library,
                null,
                50
            ).rows
        ).toEqual([]);
    });

    it("splits the library from the trash, and leaves out an identical copy's entry", () => {
        addMedia("kept");
        addMedia("binned");
        addMedia("moving");
        addMedia("twin");
        for (const id of ["kept", "binned", "moving", "twin"]) fail(id);
        trashed("binned");
        trashed("moving", { moved: false });
        trashed("twin", { twin: true });

        expect(ids(library)).toEqual(["kept"]);
        expect(ids(trash).sort()).toEqual(["binned", "moving"]);

        const rows = stageRepo.listSettledFailures(probe, trash, null, 50).rows;
        expect(rows.find((row) => row.mediaId === "moving")).toMatchObject({ moving: 1 });
        expect(rows.find((row) => row.mediaId === "binned")).toMatchObject({
            moving: 0,
            entryId: "t-binned",
        });
    });

    it("shows only the libraries the caller can reach", () => {
        addMedia("m1");
        fail("m1");

        expect(ids({ place: "library", rootIds: ["elsewhere"] })).toEqual([]);
        expect(ids({ place: "library", rootIds: [] })).toEqual([]);
    });

    it("narrows to a selection", () => {
        addMedia("a");
        addMedia("b");
        fail("a");
        fail("b");

        expect(ids({ ...library, mediaIds: ["b", "not-listed"] })).toEqual(["b"]);
    });

    /** Equal sizes are the case a cursor on size alone would skip or repeat. */
    it("walks every row exactly once, largest first, across equal sizes", () => {
        const sizes: Record<string, number> = { a: 500, b: 300, c: 300, d: 300, e: 100 };

        for (const [id, bytes] of Object.entries(sizes)) {
            addMedia(id);
            sized(id, bytes);
            fail(id);
        }

        const seen: string[] = [];
        let after: stageRepo.SettledFailureCursor | null = null;

        do {
            const page = stageRepo.listSettledFailures(probe, library, after, 2);
            seen.push(...page.rows.map((row) => row.mediaId));
            after = page.next;
        } while (after);

        expect(seen).toEqual(["a", "b", "c", "d", "e"]);
        expect(stageRepo.summarizeSettledFailures(probe, library)).toEqual({
            count: 5,
            bytes: 1500,
        });
    });
});
