import type { UserOverlay } from "@private-stock/core";

import { db } from "../db.js";

/**
 * The per-user overlay (§6).
 *
 * Every function takes `userId` explicitly. Rows are created on demand — a user who has
 * never touched an item simply has no row, which is why the library query LEFT JOINs.
 */

const ensureRow = (userId: string, mediaId: string): void => {
    db.prepare(
        `INSERT INTO "UserMedia" ("userId", "mediaId", "updatedAt")
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("userId", "mediaId") DO NOTHING`
    ).run(userId, mediaId);
};

export const setRating = (userId: string, mediaId: string, rating: number | null): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia" SET "rating" = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(rating, userId, mediaId);
};

// Booleans are 1 or NULL, never 0 — the partial indexes depend on it.
export const setFavorite = (userId: string, mediaId: string, favorite: boolean): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia" SET "favorite" = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(favorite ? 1 : null, userId, mediaId);
};

export const setHidden = (userId: string, mediaId: string, hidden: boolean): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia" SET "hidden" = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(hidden ? 1 : null, userId, mediaId);
};

/**
 * Says explicitly whether this viewer has watched the item (§14b).
 *
 * The manual half of the rule, and the reason `watchedAt` is a stored column rather than
 * something derived from `viewCount`: that is free, and it cannot be corrected. Being unable to say "yes, I have seen this" is the failure that
 * matters, and it is the one a derivation cannot fix.
 */
export const setWatched = (userId: string, mediaId: string, watched: boolean): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia"
            SET "watchedAt" = ${watched ? "CURRENT_TIMESTAMP" : "NULL"},
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(userId, mediaId);
};

/**
 * The automatic half: thirty seconds of uninterrupted playback have gone by.
 *
 * **Only ever sets, and only when unset.** Two things follow from that, both wanted. A
 * rewatch cannot clear the mark, which is what "it survives a rewatch" means; and the
 * timestamp keeps saying when you *first* finished with the item rather than sliding
 * forward every time it is replayed, so "watched recently" stays a question about your
 * history rather than about the last time the file was opened.
 *
 * Idempotent, which matters because the caller is a player that may announce the same
 * threshold more than once across a reload or a second tab.
 */
export const markWatched = (userId: string, mediaId: string): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia"
            SET "watchedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ? AND "watchedAt" IS NULL`
    ).run(userId, mediaId);
};

/**
 * A view that counted: the watched threshold reached, or the item played to its end (§14b).
 *
 * Moves `lastViewedAt`, which is what "Recently viewed" orders by, and counts a view once per
 * play when `finished`. A glance that reached neither records nothing — "opened at all" was
 * rejected as a meaning for watched, and it is no better as a meaning for viewed.
 */
export const recordView = (userId: string, mediaId: string, finished: boolean): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia"
            SET "lastViewedAt" = CURRENT_TIMESTAMP,
                "viewCount" = "viewCount" + ?,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(finished ? 1 : 0, userId, mediaId);
};

/**
 * This viewer's private note on an item (§6, §14b).
 *
 * Empty is stored as NULL, for the same reason a boolean is 1 or NULL: "" and "no note" are
 * one state, and keeping two spellings of it would mean every reader had to check for both.
 * So clearing the box and never having written in it leave the same row behind, and deleting
 * a note needs no second endpoint.
 *
 * Trimmed here rather than at the route, next to the rule it enforces. The column's CHECK is
 * on the stored length, so trimming after validation is what makes "2000 characters and a
 * trailing newline" a note rather than a rejection.
 *
 * Nothing in the search index reads this. One shared FTS document cannot carry per-user text
 * without leaking it into another viewer's results (§5c), which is why no per-user field is
 * indexed and why this one is not an exception.
 */
export const setNote = (userId: string, mediaId: string, note: string | null): void => {
    ensureRow(userId, mediaId);

    const trimmed = note?.trim();

    db.prepare(
        `UPDATE "UserMedia" SET "note" = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(trimmed ? trimmed : null, userId, mediaId);
};

export interface OverlayRow extends UserOverlay {
    userId: string;
}

/**
 * Every viewer's record of one item (§10c).
 *
 * **Every viewer, not the caller's own.** This feeds the merge that runs when a duplicate is
 * eliminated, and eliminating a copy is an administrator's action: reading only their own
 * overlay would quietly discard everybody else's ratings and notes on the way past, which is
 * the precise bug the merge exists to prevent. This is also why it takes no `userId` — the
 * only honest answer here is all of them.
 */
export const listOverlays = (mediaId: string): OverlayRow[] =>
    (
        db
            .prepare(
                `SELECT "userId", "rating", "favorite", "hidden", "viewCount",
                        "lastViewedAt", "watchedAt", "note"
                   FROM "UserMedia" WHERE "mediaId" = ?`
            )
            .all(mediaId) as {
            userId: string;
            rating: number | null;
            favorite: number | null;
            hidden: number | null;
            viewCount: number;
            lastViewedAt: string | null;
            watchedAt: string | null;
            note: string | null;
        }[]
    ).map((row) => ({ ...row, favorite: row.favorite === 1, hidden: row.hidden === 1 }));

/**
 * Writes a whole overlay at once, creating the row if the viewer had none.
 *
 * Field-by-field setters would be seven statements and seven chances to leave a half-merged
 * row behind, so the merge writes the record it computed rather than replaying the edits that
 * would have produced it. Booleans go back as 1 or NULL — the partial indexes depend on it.
 */
export const writeOverlay = (userId: string, mediaId: string, overlay: UserOverlay): void => {
    ensureRow(userId, mediaId);
    db.prepare(
        `UPDATE "UserMedia"
            SET "rating" = ?, "favorite" = ?, "hidden" = ?, "viewCount" = ?,
                "lastViewedAt" = ?, "watchedAt" = ?, "note" = ?,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "mediaId" = ?`
    ).run(
        overlay.rating,
        overlay.favorite ? 1 : null,
        overlay.hidden ? 1 : null,
        overlay.viewCount,
        overlay.lastViewedAt,
        overlay.watchedAt,
        overlay.note,
        userId,
        mediaId
    );
};
