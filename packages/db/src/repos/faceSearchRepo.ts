import { randomUUID } from "node:crypto";

import type { FaceSearchState } from "@private-stock/core";

import { db } from "../db.js";

/**
 * "Who is this?" (§5f): a search of the library's faces from the frame somebody had on screen.
 *
 * Run by the `faceSearch` job, one an item, which runs every search of that item waiting before it
 * finishes — so a second press while it runs is picked up rather than refused by the queue's
 * uniqueness, as the OCR bench's trials are.
 */

export interface FaceSearchRow {
    id: string;
    mediaId: string;
    atMs: number;
    state: FaceSearchState;
    resultJson: string | null;
    error: string | null;
}

const SELECT_COLUMNS = `"id", "mediaId", "atMs", "state", "resultJson", "error"`;

/** Somebody is waiting with the item open, as at the OCR bench (§7c). */
const SEARCH_PRIORITY = 20;

/** The item's job, unless one is already waiting or running: that one runs this search too. */
const enqueue = (mediaId: string, userId: string): void => {
    db.prepare(
        `INSERT INTO "Job"
             ("id", "kind", "mediaId", "fileId", "priority", "requestedByUserId", "mediaAddedAt",
              "updatedAt")
         SELECT ?, 'faceSearch', m."id", fl."fileId", ?, ?, m."addedAt", CURRENT_TIMESTAMP
           FROM "Media" m
           JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
          WHERE m."id" = ?
         ON CONFLICT DO NOTHING`
    ).run(randomUUID(), SEARCH_PRIORITY, userId, mediaId);
};

/**
 * Ask who is at `atMs` in the item; returns the search's id. Searches are kept a day — long enough
 * to come back to from an item one found — and the old ones go as new ones come.
 */
export const start = (mediaId: string, atMs: number, userId: string): string => {
    const id = randomUUID();

    db.transaction(() => {
        db.prepare(
            `DELETE FROM "FaceSearch" WHERE "requestedAt" < datetime('now', '-1 day')`
        ).run();
        db.prepare(
            `INSERT INTO "FaceSearch" ("id", "mediaId", "atMs", "requestedByUserId")
             VALUES (?, ?, ?, ?)`
        ).run(id, mediaId, atMs, userId);
        enqueue(mediaId, userId);
    })();

    return id;
};

export const find = (id: string): FaceSearchRow | undefined =>
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM "FaceSearch" WHERE "id" = ?`).get(id) as
        FaceSearchRow | undefined;

/**
 * A search still waiting with no job to run it: asked for in the moment between its item's job
 * finding nothing more to do and leaving the queue. Queued again; a no-op while a job waits.
 */
export const requeueIfStranded = (row: FaceSearchRow, userId: string): void => {
    if (row.state === "pending") {
        enqueue(row.mediaId, userId);
    }
};

/**
 * Searches left running by a worker that stopped mid-way, waiting again. Only one job an item runs
 * at a time — the queue's uniqueness covers a claimed job — so at its start nothing else has them.
 */
export const resumeInterrupted = (mediaId: string): void => {
    db.prepare(
        `UPDATE "FaceSearch" SET "state" = 'pending' WHERE "mediaId" = ? AND "state" = 'running'`
    ).run(mediaId);
};

/** The next of this item's searches waiting, the longest waiting first. */
export const nextPending = (mediaId: string): FaceSearchRow | undefined =>
    db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "FaceSearch"
              WHERE "mediaId" = ? AND "state" = 'pending'
              ORDER BY "requestedAt", rowid`
        )
        .get(mediaId) as FaceSearchRow | undefined;

/** False when it is no longer waiting, so the caller moves on rather than running it twice. */
export const markRunning = (id: string): boolean =>
    db
        .prepare(
            `UPDATE "FaceSearch" SET "state" = 'running' WHERE "id" = ? AND "state" = 'pending'`
        )
        .run(id).changes > 0;

export const complete = (id: string, resultJson: string): void => {
    db.prepare(
        `UPDATE "FaceSearch"
            SET "state" = 'done', "resultJson" = ?, "finishedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" = 'running'`
    ).run(resultJson, id);
};

export const fail = (id: string, error: string): void => {
    db.prepare(
        `UPDATE "FaceSearch"
            SET "state" = 'failed', "error" = ?, "finishedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ? AND "state" = 'running'`
    ).run(error.slice(0, 500), id);
};
