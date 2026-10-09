import { randomUUID } from "node:crypto";

import type { OcrTrialState } from "@private-stock/core";

import { db } from "../db.js";

/**
 * The OCR test bench's scratch results (§5d "Settings and the test bench").
 *
 * A trial is one video read under one set of settings. They come in pairs — the current
 * settings and a candidate — and each new run replaces the pair, so the table only ever holds
 * the latest comparison. None of it reaches `MediaText`.
 */

export interface OcrTrialRow {
    id: string;
    mediaId: string;
    side: "current" | "candidate";
    settingsJson: string;
    state: OcrTrialState;
    findingsJson: string | null;
    framesRead: number | null;
    elapsedMs: number | null;
    error: string | null;
}

const SELECT_COLUMNS = `"id", "mediaId", "side", "settingsJson", "state", "findingsJson",
                        "framesRead", "elapsedMs", "error"`;

/** Requested work's priority for OCR: somebody is waiting on the comparison (§7c). */
const TRIAL_PRIORITY = 20;

/**
 * Start a comparison on one video: replace its trials and queue the job that runs them.
 *
 * Requested work, so it goes ahead of the background queue and outside the working window —
 * somebody is sitting in front of the bench waiting for it.
 *
 * One job per video runs every pending trial it has. If a job for this video is already
 * queued or running the insert is skipped by the queue's uniqueness, and that job picks the
 * new trials up before it finishes (`nextPending`), so replacing a comparison mid-run loses
 * nothing.
 */
export const replaceForMedia = (
    mediaId: string,
    sides: { side: "current" | "candidate"; settingsJson: string }[],
    userId: string
): void => {
    db.transaction(() => {
        db.prepare(`DELETE FROM "OcrTrial" WHERE "mediaId" = ?`).run(mediaId);

        const insert = db.prepare(
            `INSERT INTO "OcrTrial" ("id", "mediaId", "side", "settingsJson", "createdByUserId")
             VALUES (?, ?, ?, ?, ?)`
        );

        for (const side of sides) {
            insert.run(randomUUID(), mediaId, side.side, side.settingsJson, userId);
        }

        db.prepare(
            `INSERT INTO "Job"
                 ("id", "kind", "mediaId", "fileId", "priority", "requestedByUserId",
                  "mediaAddedAt", "updatedAt")
             SELECT ?, 'ocrTrial', ?, fl."fileId", ?, ?,
                    (SELECT "addedAt" FROM "Media" WHERE "id" = ?), CURRENT_TIMESTAMP
               FROM "MediaFileLink" fl
              WHERE fl."mediaId" = ? AND fl."role" = 'original'
             ON CONFLICT DO NOTHING`
        ).run(randomUUID(), mediaId, TRIAL_PRIORITY, userId, mediaId, mediaId);
    })();
};

/** The next trial waiting to run for this video, current settings first. */
export const nextPending = (mediaId: string): OcrTrialRow | undefined =>
    db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "OcrTrial"
              WHERE "mediaId" = ? AND "state" = 'pending'
              ORDER BY "side" DESC`
        )
        .get(mediaId) as OcrTrialRow | undefined;

/**
 * Mark a trial running. False when it is no longer pending — replaced by a newer run, or
 * taken by another worker — so the caller moves on rather than running it twice.
 */
export const markRunning = (id: string): boolean =>
    db
        .prepare(`UPDATE "OcrTrial" SET "state" = 'running' WHERE "id" = ? AND "state" = 'pending'`)
        .run(id).changes > 0;

/** Record a result. A trial replaced while it ran has gone, and this then changes nothing. */
export const complete = (
    id: string,
    result: { findingsJson: string; framesRead: number; elapsedMs: number }
): void => {
    db.prepare(
        `UPDATE "OcrTrial"
            SET "state" = 'done', "findingsJson" = ?, "framesRead" = ?, "elapsedMs" = ?,
                "error" = NULL, "finishedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(result.findingsJson, result.framesRead, result.elapsedMs, id);
};

export const fail = (id: string, error: string): void => {
    db.prepare(
        `UPDATE "OcrTrial"
            SET "state" = 'failed', "error" = ?, "finishedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(error.slice(0, 500), id);
};

export const listForMediaIds = (mediaIds: string[]): OcrTrialRow[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    return db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "OcrTrial"
              WHERE "mediaId" IN (${mediaIds.map(() => "?").join(", ")})`
        )
        .all(...mediaIds) as OcrTrialRow[];
};

/** Drop the trials of videos taken off the bench, so nothing is kept for a list nobody shows. */
export const removeForMedia = (mediaIds: string[]): void => {
    if (mediaIds.length === 0) {
        return;
    }

    db.prepare(
        `DELETE FROM "OcrTrial" WHERE "mediaId" IN (${mediaIds.map(() => "?").join(", ")})`
    ).run(...mediaIds);
};
