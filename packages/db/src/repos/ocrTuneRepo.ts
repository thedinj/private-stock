import { randomUUID } from "node:crypto";

import type { TuneCostWeight, TuneMode, TuneRunState } from "@private-stock/core";

import { db } from "../db.js";

/**
 * OCR tuning runs (§5d "Tuning against expected text").
 *
 * One run at a time, as one job: the search reads frames and holds a core, and two searches
 * over the same bench would read the same frames twice for no gain.
 */

export interface OcrTuneRunRow {
    id: string;
    state: TuneRunState;
    mode: TuneMode;
    costWeight: TuneCostWeight;
    stage: string | null;
    progress: number;
    resultJson: string | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
}

const SELECT_COLUMNS = `"id", "state", "mode", "costWeight", "stage", "progress", "resultJson",
                        "error", "createdAt", "finishedAt"`;

/** Runs kept for looking back at; older ones go when a new one starts. */
const HISTORY = 10;

/** Requested work's priority for OCR: an administrator started it and is watching (§7c). */
const TUNE_PRIORITY = 20;

export const findById = (id: string): OcrTuneRunRow | undefined =>
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM "OcrTuneRun" WHERE "id" = ?`).get(id) as
        OcrTuneRunRow | undefined;

export const findLatest = (): OcrTuneRunRow | undefined =>
    db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "OcrTuneRun"
              ORDER BY "createdAt" DESC, rowid DESC LIMIT 1`
        )
        .get() as OcrTuneRunRow | undefined;

export const findActive = (): OcrTuneRunRow | undefined =>
    db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "OcrTuneRun"
              WHERE "state" IN ('pending', 'running') LIMIT 1`
        )
        .get() as OcrTuneRunRow | undefined;

/**
 * Create a run and queue the job that performs it, as requested work: ahead of the background
 * queue and outside the working window, because an administrator started it and is waiting.
 */
export const start = (mode: TuneMode, costWeight: TuneCostWeight, userId: string): string => {
    const id = randomUUID();

    db.transaction(() => {
        db.prepare(
            `INSERT INTO "OcrTuneRun" ("id", "mode", "costWeight", "createdByUserId")
             VALUES (?, ?, ?, ?)`
        ).run(id, mode, costWeight, userId);

        db.prepare(
            `INSERT INTO "Job"
                 ("id", "kind", "payloadJson", "priority", "requestedByUserId", "maxAttempts",
                  "updatedAt")
             VALUES (?, 'ocrTune', ?, ?, ?, 1, CURRENT_TIMESTAMP)`
        ).run(randomUUID(), JSON.stringify({ runId: id }), TUNE_PRIORITY, userId);

        db.prepare(
            `DELETE FROM "OcrTuneRun"
              WHERE "id" NOT IN (
                  SELECT "id" FROM "OcrTuneRun" ORDER BY "createdAt" DESC, rowid DESC LIMIT ?
              )`
        ).run(HISTORY);
    })();

    return id;
};

/** Claim a run for working on. False when it is no longer pending — cancelled first. */
export const markRunning = (id: string): boolean =>
    db
        .prepare(
            `UPDATE "OcrTuneRun" SET "state" = 'running' WHERE "id" = ? AND "state" = 'pending'`
        )
        .run(id).changes > 0;

export const setProgress = (id: string, stage: string, progress: number): void => {
    db.prepare(
        `UPDATE "OcrTuneRun" SET "stage" = ?, "progress" = ?
          WHERE "id" = ? AND "state" = 'running'`
    ).run(stage.slice(0, 200), Math.max(0, Math.min(1, progress)), id);
};

export const complete = (id: string, resultJson: string): void => {
    db.prepare(
        `UPDATE "OcrTuneRun"
            SET "state" = 'done', "progress" = 1, "stage" = NULL, "resultJson" = ?,
                "finishedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" = 'running'`
    ).run(resultJson, id);
};

export const finish = (id: string, state: "failed" | "cancelled", error: string | null): void => {
    db.prepare(
        `UPDATE "OcrTuneRun"
            SET "state" = ?, "error" = ?, "finishedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" IN ('pending', 'running')`
    ).run(state, error?.slice(0, 500) ?? null, id);
};

/**
 * Stop the active run.
 *
 * The job is marked cancelled, and its next heartbeat — an `UPDATE ... WHERE state = 'claimed'`
 * — matches nothing, which aborts it within a tick (the `cancelTranscode` pattern). The run is
 * marked here too, so a run whose job had not been claimed yet never starts.
 */
export const cancelActive = (): boolean => {
    const active = findActive();

    if (!active) {
        return false;
    }

    db.transaction(() => {
        db.prepare(
            `UPDATE "Job"
                SET "state" = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "kind" = 'ocrTune' AND "state" IN ('pending', 'claimed')`
        ).run();
        finish(active.id, "cancelled", null);
    })();

    return true;
};

/** What the tuner needs about each video: where its original is, and what it is. */
export interface TuneSource {
    mediaId: string;
    fileId: string;
    kind: "image" | "video";
    durationMs: number | null;
    size: number;
    mtime: number;
}

export const listSources = (mediaIds: string[]): TuneSource[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    return db
        .prepare(
            `SELECT m."id" AS "mediaId", f."id" AS "fileId", m."kind", m."durationMs",
                    f."size", f."mtime"
               FROM "Media" m
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
               JOIN "MediaFile" f ON f."id" = fl."fileId" AND f."state" = 'active'
              WHERE m."id" IN (${mediaIds.map(() => "?").join(", ")})`
        )
        .all(...mediaIds) as TuneSource[];
};
