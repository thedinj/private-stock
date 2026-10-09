import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/** Scan runs, so the UI can show progress and the admin page a history. */

export interface ScanRow {
    id: string;
    rootId: string;
    state: "running" | "done" | "failed";
    filesSeen: number;
    filesAdded: number;
    filesChanged: number;
    filesMissing: number;
    /** Recognised at a new path, so the item kept its tags and ratings rather than being
     *  counted as one disappearance and one arrival (§7). */
    filesMoved: number;
    lastError: string | null;
    startedAt: string;
    finishedAt: string | null;
}

export const start = (rootId: string): ScanRow => {
    const id = randomUUID();
    db.prepare(`INSERT INTO "Scan" ("id", "rootId") VALUES (?, ?)`).run(id, rootId);

    return db.prepare(`SELECT * FROM "Scan" WHERE "id" = ?`).get(id) as ScanRow;
};

export interface ScanCounts {
    filesSeen: number;
    filesAdded: number;
    filesChanged: number;
    filesMissing: number;
    /** Files recognised at a new path, whose items kept everything attached to them. */
    filesMoved: number;
}

export const updateCounts = (id: string, counts: ScanCounts): void => {
    db.prepare(
        `UPDATE "Scan"
            SET "filesSeen" = ?, "filesAdded" = ?, "filesChanged" = ?, "filesMissing" = ?,
                "filesMoved" = ?
          WHERE "id" = ?`
    ).run(
        counts.filesSeen,
        counts.filesAdded,
        counts.filesChanged,
        counts.filesMissing,
        counts.filesMoved,
        id
    );
};

export const finish = (id: string, counts: ScanCounts): void => {
    db.prepare(
        `UPDATE "Scan"
            SET "state" = 'done', "finishedAt" = CURRENT_TIMESTAMP,
                "filesSeen" = ?, "filesAdded" = ?, "filesChanged" = ?, "filesMissing" = ?
          WHERE "id" = ?`
    ).run(counts.filesSeen, counts.filesAdded, counts.filesChanged, counts.filesMissing, id);
};

export const fail = (id: string, error: string): void => {
    db.prepare(
        `UPDATE "Scan"
            SET "state" = 'failed', "finishedAt" = CURRENT_TIMESTAMP, "lastError" = ?
          WHERE "id" = ?`
    ).run(error.slice(0, 2000), id);
};

export const isAnyRunning = (): boolean =>
    !!db.prepare(`SELECT 1 FROM "Scan" WHERE "state" = 'running' LIMIT 1`).get();

export const listRecent = (limit = 20): ScanRow[] =>
    db.prepare(`SELECT * FROM "Scan" ORDER BY "startedAt" DESC LIMIT ?`).all(limit) as ScanRow[];

/**
 * Close out scans left running by a killed process.
 *
 * Without this the UI would show a scan in progress forever after an ungraceful restart,
 * which Container Station restarts routinely are — and every deploy is one.
 *
 * Two callers with different certainty. At worker boot nothing can be scanning yet — there is
 * one worker and scans run at concurrency 1 — so every running row is a dead one and
 * `olderThanMinutes` is 0. Waiting for the hourly sweep instead left a scan interrupted by a
 * deploy showing as "Scanning" for up to two hours, with the library stats polled at the
 * scanning rate the whole time (§20). The hourly sweep keeps its margin as a backstop.
 */
export const failStaleRunning = (olderThanMinutes = 60): number =>
    db
        .prepare(
            `UPDATE "Scan"
                SET "state" = 'failed', "finishedAt" = CURRENT_TIMESTAMP,
                    "lastError" = COALESCE("lastError", 'Interrupted by a restart')
              WHERE "state" = 'running' AND "startedAt" <= datetime('now', ?)`
        )
        .run(`-${olderThanMinutes} minutes`).changes;

/**
 * The scan happening right now, if one is.
 *
 * Only ever one: the queue runs `scan` at concurrency 1, so this takes the most recent
 * running row rather than pretending to handle a set. `startedAt DESC` matters anyway,
 * because `failStaleRunning` only sweeps rows older than an hour — a killed worker can leave
 * a running row behind for that long, and the newest is the one that is actually live.
 */
export const currentRun = (): ScanRow | undefined =>
    db
        .prepare(`SELECT * FROM "Scan" WHERE "state" = 'running' ORDER BY "startedAt" DESC LIMIT 1`)
        .get() as ScanRow | undefined;

/**
 * How many files this root held at the end of its last complete walk.
 *
 * The only honest denominator a running scan has. A directory walk does not know its own
 * total until it finishes, so a first scan gets a counter and every scan after it gets a bar
 * measured against last time -- an estimate that is wrong by exactly how much the library
 * changed, which is usually very little and never unboundedly.
 *
 * Failed runs are excluded: a walk that died a tenth of the way through would otherwise
 * become the estimate, and the next scan's bar would hit 100% almost immediately and stay
 * there, which is worse than having no bar at all.
 */
export const lastCompletedFilesSeen = (rootId: string): number | null => {
    const row = db
        .prepare(
            `SELECT "filesSeen" FROM "Scan"
              WHERE "rootId" = ? AND "state" = 'done'
              ORDER BY "startedAt" DESC LIMIT 1`
        )
        .get(rootId) as { filesSeen: number } | undefined;

    return row?.filesSeen ?? null;
};
