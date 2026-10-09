import {
    STAGES,
    findStage,
    sweepIncludes,
    type StageDefinition,
    type StagePolicy,
    type StageState,
} from "@private-stock/core";
import { stageRepo, type Db } from "@private-stock/db";

import { enqueue, outstandingForKind } from "./queue.js";

/**
 * How many covers a backfill pass queues at once.
 *
 * The queue is the throttle, not this number — but enqueuing 200k rows in one statement to
 * be worked through two at a time only makes the `Job` table large. A bounded pass that runs
 * again when it has made progress keeps the queue the size of the work actually in flight.
 */
export const COVER_BACKFILL_BATCH = 500;

/**
 * How deep one stage's queue may be before the sweep stops adding to it.
 *
 * The comment above says the bounded pass "keeps the queue the size of the work actually in
 * flight", and it did not: nothing looked at the queue, so 500 per stage went in every five
 * minutes whether or not the last 500 had been touched. On the real library that reached **25,206
 * pending rows in a 97,811-row `Job` table** — a work list four days long, in the table every
 * insert, claim and completion maintains four indexes over, competing for page cache with the
 * catalogue people are actually reading (§20).
 *
 * Nothing is lost by refusing: the sweep runs again in five minutes and `mediaIdsNeedingStage`
 * re-derives what is owed from the stage table, which is the durable record. A queue is a work
 * list, not a plan.
 *
 * Four batches deep, so a stage always has more queued than its concurrency can take and the
 * workers never idle waiting for the next pass.
 */
export const STAGE_QUEUE_CEILING = COVER_BACKFILL_BATCH * 4;

/**
 * How long a stage that had nothing to do is left alone, unless something changes first.
 *
 * Even with its index the candidate query is a walk of every item (§20), and on a library that
 * has caught up it answers "nothing" for every stage, every five minutes. A stage found idle is
 * skipped until its own mark moves (`stageChangeMarks`) or an hour passes. The hour is for what
 * the mark cannot see: an item restored from the bin, a failure retried past its first attempt, a
 * stage row the orphan sweep cleared because its file was gone, a queued job deleted with its
 * item's trashing. None of those is urgent; all of them were only ever found by this sweep, and
 * they still are, an hour late at most.
 */
export const IDLE_STAGE_RECHECK_MS = 60 * 60 * 1000;

/**
 * What the sweep remembers about stages that had nothing to do (`IDLE_STAGE_RECHECK_MS`).
 *
 * `mark` describes the world now — anything that changes when new work may have appeared for
 * that stage — and `seen` is the caller's, kept across passes. In memory on purpose: a restart is
 * exactly when the sweep must look again (a recipe version bump, jobs lost with the container),
 * and an empty map is that.
 */
export interface IdleStages {
    mark: (stage: StageDefinition) => string;
    now: number;
    seen: Map<string, { mark: string; at: number }>;
}

/** The two reads a mark is made of, injectable so the composition can be tested on its own. */
export interface ChangeMarkReads {
    newestItem: () => number;
    newestOutcome: (stage: string, state: StageState, version: number) => number;
}

/**
 * Per stage, what can make that stage owe work it did not owe a pass ago (§20).
 *
 * The mark used to be the newest row in all of `MediaStage`, and while any backlog drained every
 * job's first outcome moved it: in production every idle stage re-ran its candidate query every
 * five minutes, mostly to answer nothing — 41 s of reads in twenty minutes. Each stage now
 * watches only its own causes:
 *
 *  - a new item, which owes every stage that does not wait for the probe the moment it exists;
 *  - for a stage that does, a new successful probe — the moment an item starts owing it;
 *  - a new failure of the stage itself, which the sweep retries;
 *  - the admin's switch for the stage.
 *
 * Each is one index descent, and the first two are shared by every stage in a pass. A recipe
 * version bump needs no part of its own: it ships with a restart, which empties `seen`.
 *
 * What a stage's own successes cannot do is make it owe more, so a stage whose remaining work
 * is all queued is idle while the queue drains (`mediaIdsNeedingStage` leaves queued items out).
 */
export const stageChangeMarks = (
    policy: StagePolicy,
    reads: ChangeMarkReads = stageRepo
): ((stage: StageDefinition) => string) => {
    const probe = findStage("probe");
    let items: number | undefined;
    let probed: number | undefined;

    return (stage) => {
        items ??= reads.newestItem();
        const parts: (number | string)[] = [
            items,
            reads.newestOutcome(stage.name, "failed", stage.version),
        ];

        if (stage.needsProbe && probe) {
            probed ??= reads.newestOutcome(probe.name, "done", probe.version);
            parts.push(probed);
        }

        // Switched off and on again: looked at on the next pass rather than up to an hour later.
        parts.push(String(policy[stage.name] ?? "default"));

        return parts.join("|");
    };
};

/**
 * Queue whatever each stage still owes (§7b).
 *
 * Its own module rather than a private function in `index.ts`, so it can be tested: this is
 * where an admin's decision about a stage turns into work, and it was the one part of that
 * path nothing exercised.
 *
 * One loop over the registry, where there used to be five hand-written queries and four
 * different conventions for recording that a stage had run. Adding a capability is a registry
 * entry and a handler; this does not change.
 *
 * The sweep exists for the cases the job chain misses: a library catalogued before a stage
 * existed, a recipe version bump, artifacts deleted to reclaim space (`/data/art` is excluded
 * from backups precisely because it can be rebuilt, §13), and jobs lost to a killed container.
 */
export const backfillStages = (
    db: Db,
    policy: StagePolicy,
    /**
     * What each stage still owes. A parameter so this module can be tested against a real
     * queue without a database behind the repos, and because the sweep's own job is the
     * loop and the enqueue rather than the query.
     */
    listPending: (stage: StageDefinition) => stageRepo.PendingItem[] = (stage) =>
        stageRepo.mediaIdsNeedingStage(stage, COVER_BACKFILL_BATCH),
    /** How much of this stage is already queued. Injected for the same reason as `listPending`. */
    outstanding: (stage: StageDefinition) => number = (stage) => outstandingForKind(db, stage.name),
    /** Optional so the tests above it need not care; the worker always passes it. */
    idle?: IdleStages
): number => {
    let queued = 0;

    /**
     * Every stage, not just the automatic ones (§7b).
     *
     * The registry's `mode` is the *default*, and `sweepIncludes` is the one place that
     * combines it with what the admin decided. Looping `automaticStages()` here was the same
     * rule written twice, and it was the reason an `optIn` stage could be switched on and
     * still never sweep: the filter below would have said yes, and the loop never offered it
     * the chance to.
     */
    for (const stage of STAGES) {
        if (!sweepIncludes(stage, policy)) {
            continue;
        }

        /**
         * Read before the candidate query, never after: an outcome landing between the two
         * would otherwise be folded into a mark the query never saw.
         */
        const mark = idle?.mark(stage);
        const lastIdle = idle?.seen.get(stage.name);

        if (
            idle &&
            lastIdle &&
            lastIdle.mark === mark &&
            idle.now - lastIdle.at < IDLE_STAGE_RECHECK_MS
        ) {
            continue;
        }

        /**
         * Already deep enough. Asked before the candidate query rather than after, because that
         * query is the expensive half — a join over every listable item against the stage table,
         * which on this library is the sweep's whole cost when there is nothing useful to add.
         */
        if (outstanding(stage) >= STAGE_QUEUE_CEILING) {
            continue;
        }

        const pending = listPending(stage);

        if (idle) {
            if (pending.length === 0 && mark !== undefined) {
                idle.seen.set(stage.name, { mark, at: idle.now });
            } else {
                idle.seen.delete(stage.name);
            }
        }

        for (const item of pending) {
            /**
             * No `requestedByUserId`, and that omission is load-bearing (§7c).
             *
             * The throttle exempts requested work from the working window, keyed on exactly
             * that column being non-null. Attributing swept jobs to the admin who switched
             * the stage on would look like an improvement and would mean enabling OCR
             * saturates the box at two in the afternoon. Asserted in a test, because nothing
             * here looks fragile.
             */
            enqueue(db, {
                kind: stage.name,
                mediaId: item.id,
                fileId: item.fileId,
                priority: stage.priority,
            });
        }

        queued += pending.length;
    }

    return queued;
};
