import { randomUUID } from "node:crypto";

import { PHASH_BANDS, hashBands } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Perceptual hashes and the candidate index (§10).
 *
 * The band columns exist so that finding "hashes near this one" is an indexed equality
 * lookup rather than a scan of the whole table. Everything here is built around that: writes
 * derive the bands from the hash so the two cannot disagree, and reads express the candidate
 * query as a union of per-band lookups.
 */

const BAND_COLUMNS = Array.from({ length: PHASH_BANDS }, (_, i) => `"band${i}"`);

export interface PhashRow {
    mediaId: string;
    hash: Uint8Array;
}

export interface VideoFrameRow extends PhashRow {
    frameIdx: number;
    atMs: number;
}

/**
 * Stores an image's hash.
 *
 * The bands are computed here rather than accepted from the caller. They are a pure function
 * of the hash, and a caller that passed inconsistent ones would produce a row that is
 * invisible to the candidate query while looking perfectly valid in the table — the kind of
 * corruption that is only discovered when someone wonders why a duplicate was never found.
 */
export const putImageHash = (mediaId: string, hash: Uint8Array): void => {
    const bands = hashBands(hash);

    db.prepare(
        `INSERT INTO "PhashImage" ("mediaId", "hash", ${BAND_COLUMNS.join(", ")})
         VALUES (?, ?, ${bands.map(() => "?").join(", ")})
         ON CONFLICT("mediaId") DO UPDATE SET
             "hash" = excluded."hash",
             ${BAND_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`
    ).run(mediaId, Buffer.from(hash), ...bands);
};

export const findImageHash = (mediaId: string): Uint8Array | undefined => {
    const row = db.prepare(`SELECT "hash" FROM "PhashImage" WHERE "mediaId" = ?`).get(mediaId) as
        { hash: Buffer } | undefined;

    return row ? new Uint8Array(row.hash) : undefined;
};

export interface VideoFrameInput {
    frameIdx: number;
    atMs: number;
    hash: Uint8Array;
}

/**
 * Replaces a video's frame hashes.
 *
 * Delete-then-insert inside one transaction rather than upserting each frame, because the
 * sample count can change between runs: a video hashed under an older sampling recipe would
 * otherwise keep its extra frames forever, and comparisons against it would silently use a
 * mixture of two recipes.
 */
export const putVideoHashes = (mediaId: string, frames: VideoFrameInput[]): void => {
    const insert = db.prepare(
        `INSERT INTO "PhashVideo"
             ("id", "mediaId", "frameIdx", "atMs", "hash", ${BAND_COLUMNS.join(", ")})
         VALUES (?, ?, ?, ?, ?, ${Array.from({ length: PHASH_BANDS }, () => "?").join(", ")})`
    );

    db.transaction(() => {
        db.prepare(`DELETE FROM "PhashVideo" WHERE "mediaId" = ?`).run(mediaId);

        for (const frame of frames) {
            insert.run(
                randomUUID(),
                mediaId,
                frame.frameIdx,
                frame.atMs,
                Buffer.from(frame.hash),
                ...hashBands(frame.hash)
            );
        }
    })();
};

export const listVideoHashes = (mediaId: string): VideoFrameRow[] =>
    (
        db
            .prepare(
                `SELECT "mediaId", "frameIdx", "atMs", "hash" FROM "PhashVideo"
                  WHERE "mediaId" = ? ORDER BY "frameIdx"`
            )
            .all(mediaId) as { mediaId: string; frameIdx: number; atMs: number; hash: Buffer }[]
    ).map((row) => ({ ...row, hash: new Uint8Array(row.hash) }));

/**
 * Images whose hash shares at least one band with this one.
 *
 * The union of eight equality lookups, which is the whole point of the band columns: any
 * pair within the indexed distance must share a band (§10), so this returns a superset of
 * the true matches and the caller confirms each with an exact Hamming distance.
 *
 * `DISTINCT` because a genuine near-duplicate usually shares several bands and would
 * otherwise be returned once per band — turning the confirmation step into repeated work on
 * exactly the rows that matter most.
 */
export const imageCandidates = (mediaId: string, hash: Uint8Array, limit = 500): PhashRow[] => {
    const bands = hashBands(hash);
    const clauses = bands.map((_, i) => `"band${i}" = ?`).join(" OR ");

    return (
        db
            .prepare(
                `SELECT DISTINCT "mediaId", "hash" FROM "PhashImage"
                  WHERE "mediaId" != ? AND (${clauses})
                  LIMIT ?`
            )
            .all(mediaId, ...bands, limit) as { mediaId: string; hash: Buffer }[]
    ).map((row) => ({ mediaId: row.mediaId, hash: new Uint8Array(row.hash) }));
};

/**
 * Videos with at least one frame sharing a band with one of these frames.
 *
 * Returns candidate *ids* rather than their frames. A candidate video's frames are fetched
 * only if it survives this filter, because most candidates are rejected and loading every
 * frame of every one of them up front is the expensive half of the whole pass.
 */
export const videoCandidates = (
    mediaId: string,
    frameHashes: Uint8Array[],
    limit = 200
): string[] => {
    if (frameHashes.length === 0) {
        return [];
    }

    const conditions: string[] = [];
    const params: unknown[] = [mediaId];

    for (const hash of frameHashes) {
        const bands = hashBands(hash);

        conditions.push(`(${bands.map((_, i) => `"band${i}" = ?`).join(" OR ")})`);
        params.push(...bands);
    }

    return (
        db
            .prepare(
                `SELECT DISTINCT "mediaId" FROM "PhashVideo"
                  WHERE "mediaId" != ? AND (${conditions.join(" OR ")})
                  LIMIT ?`
            )
            .all(...params, limit) as { mediaId: string }[]
    ).map((row) => row.mediaId);
};
