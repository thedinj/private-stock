import type { Db } from "@private-stock/db";

import type { ModelFamily } from "./protocol.js";

/**
 * Keeping the model child on one family while it has work (§5e, §5f).
 *
 * `embed` and `faces` share the model child, one family at a time, so their models never hold
 * memory together (`embedder.ts`). What that does not stop is the claim alternating between them
 * — the embed of each newly scanned item cutting into a faces pass, item after item — and every
 * alternation is the child retired and the other family's 90–190 MB of model read back from the
 * disks the database is already waiting on (§20). That is thrashing, and this is the cure: while
 * the child holds one family and that family has work queued, the other family's jobs are not
 * offered, until the oldest of them has waited `SWITCH_AFTER_MS`. Then they are, the child
 * switches, and the same rule keeps it on them. At most two switches an hour; nothing waits for
 * ever.
 *
 * Work somebody asked for is not held back: requested jobs are claimed apart from this.
 */

/** Which family each kind's models are. Kinds not listed load no model and are never held. */
export const FAMILY_OF: Readonly<Record<string, ModelFamily>> = { embed: "embed", faces: "faces" };

/** How long the other family's oldest job may wait before the child switches to it. */
export const SWITCH_AFTER_MS = 30 * 60 * 1000;

/**
 * The free kinds, less the other family's while the held one has work and theirs has not waited
 * long enough. `waitedMs` is, per kind with unrequested work available now, how long its oldest
 * job has been waiting.
 */
export const withAffinity = (
    free: readonly string[],
    held: ModelFamily | null,
    waitedMs: ReadonlyMap<string, number>
): string[] => {
    if (held === null) {
        return [...free];
    }

    const heldHasWork = [...waitedMs.keys()].some((kind) => FAMILY_OF[kind] === held);

    if (!heldHasWork) {
        return [...free];
    }

    return free.filter((kind) => {
        const family = FAMILY_OF[kind];

        return (
            family === undefined || family === held || (waitedMs.get(kind) ?? 0) >= SWITCH_AFTER_MS
        );
    });
};

/**
 * How long each model kind's oldest unrequested, available job has waited, in ms.
 *
 * A walk of those kinds' live jobs, so the loop asks this at most every `WAITED_TTL_MS` rather
 * than on every claim: during a first pass there are thousands of them.
 */
const WAITED_TTL_MS = 15_000;

let cached: { at: number; value: Map<string, number> } | null = null;

/**
 * Never fatal: a failure here is no affinity for a while, not a stopped worker. The first version
 * named the index with a WHERE clause SQLite could not match to its partial condition, the query
 * threw "no query solution" on every claim, and the claim loop -- which does not expect this to
 * throw -- took the worker down with it. The index's own condition is now spelled out first.
 */
export const modelKindsWaited = (db: Db, now = Date.now()): Map<string, number> => {
    if (cached && now - cached.at < WAITED_TTL_MS) {
        return cached.value;
    }

    try {
        return readWaited(db, now);
    } catch (error) {
        console.error(`Model affinity unavailable: ${(error as Error).message}`);
        cached = { at: now, value: new Map() };

        return cached.value;
    }
};

const readWaited = (db: Db, now: number): Map<string, number> => {
    const kinds = Object.keys(FAMILY_OF);
    const rows = db
        .prepare(
            `SELECT "kind",
                    (julianday('now') - julianday(min("availableAt"))) * 86400000 AS "waited"
               FROM "Job" INDEXED BY "idx_Job_pending_unique"
              WHERE "state" IN ('pending', 'claimed') AND "state" = 'pending'
                AND "kind" IN (${kinds.map(() => "?").join(", ")})
                AND "requestedByUserId" IS NULL AND "availableAt" <= CURRENT_TIMESTAMP
              GROUP BY "kind"`
        )
        .all(...kinds) as { kind: string; waited: number }[];

    cached = { at: now, value: new Map(rows.map((row) => [row.kind, Math.max(0, row.waited)])) };

    return cached.value;
};
