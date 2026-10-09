import { randomUUID } from "node:crypto";

import { db } from "../db.js";
import * as changeLogRepo from "./changeLogRepo.js";

/**
 * Background web-safe renditions (§8).
 *
 * A `Variant` row exists only once the file behind it is complete: the transcode job encodes
 * to a temporary name and renames on success, then writes the row. There is deliberately no
 * "pending" variant state — progress belongs to the `Job` row, and a variant that exists but
 * cannot be played is worse than no variant at all, because the player would choose it.
 */

export interface VariantRow {
    id: string;
    mediaId: string;
    profile: string;
    relPath: string;
    codec: string | null;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    bytes: number | null;
    ready: 1 | null;
    lastUsedAt: string | null;
    evictedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface UpsertVariantInput {
    mediaId: string;
    profile: string;
    relPath: string;
    codec?: string | null;
    width?: number | null;
    height?: number | null;
    bitrate?: number | null;
    bytes?: number | null;
    ready?: boolean;
}

const SELECT_COLUMNS = `"id", "mediaId", "profile", "relPath", "codec", "width", "height",
                        "bitrate", "bytes", "ready", "lastUsedAt", "evictedAt", "createdAt",
                        "updatedAt"`;

export const upsert = (input: UpsertVariantInput): VariantRow =>
    db
        .prepare(
            `INSERT INTO "Variant"
                ("id", "mediaId", "profile", "relPath", "codec", "width", "height", "bitrate",
                 "bytes", "ready", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT ("mediaId", "profile") DO UPDATE SET
                "relPath" = excluded."relPath",
                "codec" = excluded."codec",
                "width" = excluded."width",
                "height" = excluded."height",
                "bitrate" = excluded."bitrate",
                "bytes" = excluded."bytes",
                "ready" = excluded."ready",
                -- Re-encoding an evicted rendition makes it present again. Leaving the mark
                -- would tell the backfill to keep its hands off a variant that is now real,
                -- and tell the next sweep it had already been reclaimed.
                "evictedAt" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
             RETURNING ${SELECT_COLUMNS}`
        )
        .get(
            randomUUID(),
            input.mediaId,
            input.profile,
            input.relPath,
            input.codec ?? null,
            input.width ?? null,
            input.height ?? null,
            input.bitrate ?? null,
            input.bytes ?? null,
            // Booleans are 1 or NULL, never 0 (§4).
            input.ready ? 1 : null
        ) as VariantRow;

export const findOne = (mediaId: string, profile: string): VariantRow | undefined =>
    db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM "Variant" WHERE "mediaId" = ? AND "profile" = ?`)
        .get(mediaId, profile) as VariantRow | undefined;

export const listForMedia = (mediaId: string): VariantRow[] =>
    db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM "Variant" WHERE "mediaId" = ? ORDER BY "profile"`)
        .all(mediaId) as VariantRow[];

/** Remove the row and return it, so the caller can delete the file it names. */
export const remove = (mediaId: string, profile: string): VariantRow | undefined => {
    const row = findOne(mediaId, profile);

    if (!row) {
        return undefined;
    }

    db.prepare(`DELETE FROM "Variant" WHERE "id" = ?`).run(row.id);

    return row;
};

/**
 * Note that a rendition was served, for the retention sweep (§8).
 *
 * Deliberately coarse. A viewer dragging the scrubber issues range requests by the dozen,
 * and every one of them passes through here — so a plain `UPDATE` would be a write per
 * request on the hot path of the one thing this app does that must not stutter. Retention is
 * measured in days; a timestamp accurate to the hour answers it exactly as well, and this
 * writes at most once per variant per hour.
 *
 * `ready = 1` in the predicate rather than a separate check: touching a rendition whose bytes
 * have been reclaimed would mark it fresh, and the sweep would then never look at it again.
 */
export const touchUsed = (mediaId: string, profile: string): void => {
    db.prepare(
        `UPDATE "Variant"
            SET "lastUsedAt" = CURRENT_TIMESTAMP
          WHERE "mediaId" = ? AND "profile" = ? AND "ready" = 1
            AND ("lastUsedAt" IS NULL OR "lastUsedAt" < datetime('now', '-1 hour'))`
    ).run(mediaId, profile);
};

/**
 * Renditions whose bytes may be reclaimed (§8).
 *
 * `coalesce(lastUsedAt, createdAt)` is the whole rule: a rendition nobody has played counts
 * as unused since it was made, not as unused for ever. Without that, a transcode finishing
 * an hour after the window opened would be deleted on the next sweep, before the person
 * waiting for it had a chance to watch it.
 *
 * Bounded, and oldest first, like every other sweep here: an admin who drops the window to a
 * day on a large library gets steady progress rather than one pass that unlinks for minutes.
 */
export const listExpired = (retentionDays: number, limit: number): VariantRow[] =>
    db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "Variant"
              WHERE "ready" = 1
                AND coalesce("lastUsedAt", "createdAt") < datetime('now', ?)
              ORDER BY coalesce("lastUsedAt", "createdAt") ASC
              LIMIT ?`
        )
        .all(`-${retentionDays} days`, limit) as VariantRow[];

/**
 * Record that a rendition's bytes are gone, keeping the row.
 *
 * The row is the memory. `ready` clears so nothing can serve a file that is not there, and
 * `evictedAt` is what stops the five-minute backfill from re-encoding the item within five
 * minutes of the sweep reclaiming it — which would make retention a way of spending CPU
 * rather than of saving disk. `bytes` clears because the number described a file that no
 * longer exists.
 */
export const markEvicted = (id: string): void => {
    db.prepare(
        `UPDATE "Variant"
            SET "ready" = NULL, "bytes" = NULL, "evictedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(id);
};

/** Whether this item's rendition was reclaimed rather than never made. */
export const wasEvicted = (mediaId: string, profile: string): boolean =>
    db
        .prepare(
            `SELECT 1 FROM "Variant"
              WHERE "mediaId" = ? AND "profile" = ? AND "evictedAt" IS NOT NULL AND "ready" IS NULL`
        )
        .get(mediaId, profile) !== undefined;

/** Media whose renditions were reclaimed, so the sweep can leave them alone. */
export const evictedMediaIds = (): Set<string> =>
    new Set(
        (
            db
                .prepare(
                    `SELECT DISTINCT "mediaId" FROM "Variant"
                      WHERE "evictedAt" IS NOT NULL AND "ready" IS NULL`
                )
                .all() as { mediaId: string }[]
        ).map((row) => row.mediaId)
    );

/**
 * Every rendition, for the teardown that follows switching transcoding off.
 *
 * Bounded and repeatable rather than one query returning the library: the job calls this
 * until it comes back empty, so a purge of 20k renditions is a sequence of small
 * transactions that a restart can resume, not one that has to survive being interrupted.
 */
export const listAny = (limit: number): VariantRow[] =>
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM "Variant" LIMIT ?`).all(limit) as VariantRow[];

/** Drop a row by id, once its file is gone. */
export const removeById = (id: string): void => {
    db.prepare(`DELETE FROM "Variant" WHERE "id" = ?`).run(id);
};

/**
 * Tell the grid a variant became playable.
 *
 * Written inside the transcode's own transaction, so an item can never flip to playable
 * without the browsers watching hearing about it (§13b).
 */
export const recordVariantChange = (mediaId: string, rootId: string | null): void => {
    changeLogRepo.record({
        entity: "variant",
        entityId: mediaId,
        rootId,
        op: "update",
        detail: "ready",
    });
};
