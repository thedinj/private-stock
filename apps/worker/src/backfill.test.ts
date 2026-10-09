import Database from "better-sqlite3";
import { initializeDatabase } from "@private-stock/db";
import { beforeEach, describe, expect, it } from "vitest";

import { findStage, type StageDefinition, type StageState } from "@private-stock/core";

import {
    IDLE_STAGE_RECHECK_MS,
    STAGE_QUEUE_CEILING,
    backfillStages,
    stageChangeMarks,
    type IdleStages,
} from "./backfill.js";

/**
 * Where an admin's decision about a stage turns into work (§7b).
 *
 * The loop used to run over `automaticStages()` and the policy filter sat inside it, which
 * is the same rule written twice — and the half that mattered was the half nothing could
 * reach. An `optIn` stage switched on passed the filter and was never offered to it, so the
 * switch worked, the setting saved, the screen said "on", and nothing ever happened.
 *
 * Against a real queue rather than a spy: the assertion that matters is a column value in
 * the `Job` table, and a mock would only prove the test matches itself.
 */

let db: Database.Database;

beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
});

/**
 * A real root, file and item. Foreign keys stay on, so the jobs this queues have to point at
 * rows that exist -- which is the same constraint the sweep works under in a live library.
 */
const givenMedia = (id: string): string => {
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "updatedAt")
         VALUES ('r1', '/media/r1', 'Root', CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`
    ).run();

    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt",
                                  "updatedAt")
         VALUES (?, 'r1', ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, `${id}.mp4`);

    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "addedAt", "updatedAt")
         VALUES (?, 'video', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id);

    return id;
};

/**
 * Every stage owes this one item, so what gets queued is decided purely by the policy.
 *
 * The query that really answers this is covered by `stageRepo`'s own property test against
 * `needsWork`; what is under test here is the loop that consults it.
 */
const everythingOwed = (mediaId: string) => (_stage: StageDefinition) => [
    { id: mediaId, fileId: `f-${mediaId}`, kind: "video" as const },
];

const queuedKinds = (): string[] =>
    (db.prepare(`SELECT "kind" FROM "Job" ORDER BY "kind"`).all() as { kind: string }[]).map(
        (row) => row.kind
    );

describe("the stage sweep", () => {
    it("leaves an opt-in stage alone until somebody turns it on", () => {
        const item = givenMedia("m1");

        backfillStages(db, {}, everythingOwed(item));

        expect(queuedKinds()).not.toContain("ocr");
        // The automatic ones are not affected by OCR being off.
        expect(queuedKinds()).toContain("cover");
    });

    it("sweeps an opt-in stage once it is turned on", () => {
        const item = givenMedia("m1");

        backfillStages(db, { ocr: true }, everythingOwed(item));

        expect(queuedKinds()).toContain("ocr");
    });

    it("stops sweeping an automatic stage that was switched off", () => {
        const item = givenMedia("m1");

        backfillStages(db, { phash: false }, everythingOwed(item));

        expect(queuedKinds()).not.toContain("phash");
        expect(queuedKinds()).toContain("cover");
    });

    /**
     * §7c exempts requested work from the working window, keyed on this column being
     * non-null. Attributing swept jobs to the admin who enabled the stage would look like an
     * improvement and would mean turning OCR on saturates the box at two in the afternoon —
     * a change nothing else in the codebase would object to.
     */
    it("queues swept work as nobody's request, so the working window still governs it", () => {
        const item = givenMedia("m1");

        backfillStages(db, { ocr: true }, everythingOwed(item));

        const requesters = db
            .prepare(`SELECT DISTINCT "requestedByUserId" AS who FROM "Job"`)
            .all() as { who: string | null }[];

        expect(requesters).toEqual([{ who: null }]);
    });

    it("reports how much it queued, which is what the startup log counts", () => {
        const item = givenMedia("m1");
        const queued = backfillStages(db, { ocr: true }, everythingOwed(item));

        expect(queued).toBe(queuedKinds().length);
        expect(queued).toBeGreaterThan(0);
    });
});

/**
 * The queue-depth ceiling (§20).
 *
 * The sweep's own comment always claimed it kept "the queue the size of the work actually in
 * flight", and nothing enforced it: 500 rows per stage went in every five minutes whether or not
 * the previous 500 had been touched. The real library reached 25,206 pending rows in a 97,811-row
 * `Job` table before anybody looked.
 */
describe("the sweep's queue ceiling", () => {
    const deep = (_stage: StageDefinition) => STAGE_QUEUE_CEILING;
    const empty = (_stage: StageDefinition) => 0;

    it("adds nothing to a stage that is already deep enough", () => {
        const item = givenMedia("m1");

        expect(backfillStages(db, {}, everythingOwed(item), deep)).toBe(0);
        expect(queuedKinds()).toHaveLength(0);
    });

    it("still sweeps when the queue is empty", () => {
        const item = givenMedia("m1");

        expect(backfillStages(db, {}, everythingOwed(item), empty)).toBeGreaterThan(0);
        expect(queuedKinds()).toContain("cover");
    });

    /** One deep stage must not stop the others, or a slow sprite queue would starve every hash. */
    it("judges each stage on its own queue", () => {
        const item = givenMedia("m1");
        const onlyCoverIsDeep = (stage: StageDefinition) =>
            stage.name === "cover" ? STAGE_QUEUE_CEILING : 0;

        backfillStages(db, {}, everythingOwed(item), onlyCoverIsDeep);

        expect(queuedKinds()).not.toContain("cover");
        expect(queuedKinds()).toContain("phash");
    });

    /**
     * Asked before the candidate query, because that query is the expensive half — a join over
     * every listable item — and running it to throw the answer away is the cost this avoids.
     */
    it("does not even ask what is owed when the queue is full", () => {
        let asked = 0;
        const counting = (stage: StageDefinition) => {
            asked += 1;

            return everythingOwed(givenMedia(`m-${stage.name}`))(stage);
        };

        backfillStages(db, {}, counting, deep);

        expect(asked).toBe(0);
    });
});

/**
 * Stages with nothing to do are not asked again until something changes (§20).
 *
 * The candidate query is a walk of the library, and on one that has caught up it answers
 * "nothing" for every stage every five minutes. What matters is that it still answers when the
 * answer could be different: a new mark, or the hour passing.
 */
describe("the sweep's memory of idle stages", () => {
    const nothingOwed = () => [];

    const countingAsks = () => {
        const asked: string[] = [];

        return {
            asked,
            list: (stage: StageDefinition) => {
                asked.push(stage.name);

                return [];
            },
        };
    };

    const idle = (mark: string, now: number, seen: IdleStages["seen"]): IdleStages => ({
        mark: () => mark,
        now,
        seen,
    });

    it("does not ask again about a stage that had nothing, while nothing has changed", () => {
        const seen: IdleStages["seen"] = new Map();

        backfillStages(db, {}, nothingOwed, undefined, idle("1", 0, seen));

        const second = countingAsks();
        backfillStages(db, {}, second.list, undefined, idle("1", 60_000, seen));

        expect(second.asked).toHaveLength(0);
    });

    it("asks again as soon as the mark moves", () => {
        const seen: IdleStages["seen"] = new Map();

        backfillStages(db, {}, nothingOwed, undefined, idle("1", 0, seen));

        const second = countingAsks();
        backfillStages(db, {}, second.list, undefined, idle("2", 60_000, seen));

        expect(second.asked).toContain("cover");
    });

    it("asks again once the hour is up, whatever the mark says", () => {
        const seen: IdleStages["seen"] = new Map();

        backfillStages(db, {}, nothingOwed, undefined, idle("1", 0, seen));

        const second = countingAsks();
        backfillStages(db, {}, second.list, undefined, idle("1", IDLE_STAGE_RECHECK_MS, seen));

        expect(second.asked).toContain("cover");
    });

    /** A stage that found work is not idle: the next pass must look again. */
    it("keeps asking about a stage that found something", () => {
        const item = givenMedia("m1");
        const seen: IdleStages["seen"] = new Map();

        backfillStages(db, {}, everythingOwed(item), undefined, idle("1", 0, seen));

        const second = countingAsks();
        backfillStages(db, {}, second.list, undefined, idle("1", 60_000, seen));

        expect(second.asked).toContain("cover");
    });

    it("forgets nothing it was not told: without the memory every stage is asked", () => {
        backfillStages(db, {}, nothingOwed);

        const second = countingAsks();
        backfillStages(db, {}, second.list);

        expect(second.asked).toContain("cover");
    });
});

/**
 * Each stage's mark watches only what can make that stage owe work (§20).
 *
 * The mark used to be the newest row of the whole stage table, so any stage draining a backlog
 * moved it on every job and every idle stage re-ran its candidate query every pass.
 */
describe("a stage's change mark", () => {
    const cover = findStage("cover")!;
    const probe = findStage("probe")!;
    const index = findStage("index")!;

    /** A world of counters: rowids that move when the test says something happened. */
    const world = () => {
        const state = { items: 1, outcomes: new Map<string, number>() };
        const key = (stage: string, outcome: StageState, version: number) =>
            `${stage}\0${outcome}\0${version}`;

        return {
            state,
            record: (stage: StageDefinition, outcome: StageState) => {
                const k = key(stage.name, outcome, stage.version);
                state.outcomes.set(k, (state.outcomes.get(k) ?? 0) + 1);
            },
            reads: {
                newestItem: () => state.items,
                newestOutcome: (stage: string, outcome: StageState, version: number) =>
                    state.outcomes.get(key(stage, outcome, version)) ?? 0,
            },
        };
    };

    it("does not move while another stage records its outcomes", () => {
        const w = world();
        const before = stageChangeMarks({}, w.reads)(cover);

        // OCR and the search index draining their backlogs: thousands of these.
        w.record(findStage("ocr")!, "done");
        w.record(index, "done");
        w.record(cover, "done");

        expect(stageChangeMarks({}, w.reads)(cover)).toBe(before);
    });

    it("moves for a new item", () => {
        const w = world();
        const before = stageChangeMarks({}, w.reads)(index);

        w.state.items += 1;

        expect(stageChangeMarks({}, w.reads)(index)).not.toBe(before);
    });

    it("moves for a new probe when the stage waits for the probe, and only then", () => {
        const w = world();
        const coverBefore = stageChangeMarks({}, w.reads)(cover);
        const indexBefore = stageChangeMarks({}, w.reads)(index);

        w.record(probe, "done");

        expect(stageChangeMarks({}, w.reads)(cover)).not.toBe(coverBefore);
        expect(stageChangeMarks({}, w.reads)(index)).toBe(indexBefore);
    });

    it("moves for a failure of its own, which the sweep retries", () => {
        const w = world();
        const before = stageChangeMarks({}, w.reads)(cover);

        w.record(cover, "failed");

        expect(stageChangeMarks({}, w.reads)(cover)).not.toBe(before);
    });

    it("moves when the stage is switched, and not when another one is", () => {
        const w = world();
        const before = stageChangeMarks({}, w.reads)(cover);

        expect(stageChangeMarks({ ocr: true }, w.reads)(cover)).toBe(before);
        expect(stageChangeMarks({ cover: false }, w.reads)(cover)).not.toBe(before);
    });

    it("reads the shared parts once per pass, however many stages ask", () => {
        const w = world();
        let itemReads = 0;
        const marks = stageChangeMarks(
            {},
            {
                ...w.reads,
                newestItem: () => {
                    itemReads += 1;

                    return w.reads.newestItem();
                },
            }
        );

        marks(cover);
        marks(index);
        marks(probe);

        expect(itemReads).toBe(1);
    });

    it("keeps an idle stage idle through another stage's backlog, end to end", () => {
        const w = world();
        const seen: IdleStages["seen"] = new Map();
        const pass = (now: number, list: (stage: StageDefinition) => []) =>
            backfillStages(db, {}, list, undefined, {
                mark: stageChangeMarks({}, w.reads),
                now,
                seen,
            });

        pass(0, () => []);

        const asked: string[] = [];
        w.record(index, "done");
        pass(60_000, (stage) => {
            asked.push(stage.name);

            return [];
        });

        expect(asked).toHaveLength(0);
    });
});
