import type { Database } from "better-sqlite3";

/**
 * Reorder `idx_Job_claim` so claiming a job stops sorting the queue (§7d, §20).
 *
 * The claim is `state = 'pending' AND kind IN (…) AND availableAt <= now`, ordered by
 * `priority ASC, mediaAddedAt DESC, createdAt ASC`, `LIMIT 1`. The index led with
 * `("state", "availableAt", …)`, and `availableAt` is an **inequality** — which ends SQLite's
 * ability to read the remaining columns in order. So every claim gathered every pending row of
 * every claimable kind, sorted them in a temp B-tree, and took one. The old comment in `init.ts`
 * said as much and treated it as unavoidable, optimising what the sort read rather than removing
 * the sort.
 *
 * Measured on 5,000 pending rows, in memory:
 *
 * | index                                                      | per claim | plan                      |
 * | ---------------------------------------------------------- | --------- | ------------------------- |
 * | none                                                       | 1.134 ms  | SCAN + TEMP B-TREE        |
 * | `(state, availableAt, priority, mediaAddedAt, createdAt)`   | 1.587 ms  | SEARCH + TEMP B-TREE      |
 * | `(priority, mediaAddedAt DESC, createdAt, availableAt, kind)` | 0.005 ms | index order, no sort    |
 *
 * The old index was **slower than no index at all**: it paid for lookups and still sorted. On the
 * NAS, with the pages cold and ffmpeg on the same disk, that sort measured 1.2–3.7 seconds per
 * claim — in the worker's hot loop, every couple of seconds, getting worse as the backlog grew.
 *
 * Now the ordering columns lead, so the index is walked in exactly the order the claim wants and
 * `LIMIT 1` stops at the first row that matches; `availableAt` and `kind` ride along as filters,
 * so the table is touched once rather than per candidate. Partial on `state = 'pending'` for two
 * reasons: it holds only the rows a claim can possibly return, and a claim *leaves* the index
 * rather than being rewritten in it, so the write it does is cheaper too.
 *
 * The worst case is a queue whose pending rows are all of kinds this worker may not claim — a
 * throttled sweep (§7c) — where the walk goes further before it finds one. That case sorted the
 * whole set before, so it is not a regression.
 */
export function up(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_Job_claim";
        CREATE INDEX "idx_Job_claim"
            ON "Job" ("priority", "mediaAddedAt" DESC, "createdAt", "availableAt", "kind")
            WHERE "state" = 'pending';
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_Job_claim";
        CREATE INDEX "idx_Job_claim"
            ON "Job" ("state", "availableAt", "priority", "mediaAddedAt" DESC, "createdAt");
    `);
}
