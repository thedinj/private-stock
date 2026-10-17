import { randomUUID } from "node:crypto";

import { PHASH_BANDS, hashBands } from "@private-stock/core";

import { db } from "../db.js";

import { forgetClustered } from "./dupeRepo.js";

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

/** Any band equal: the indexed half of a candidate lookup, one equality per band column. */
const BANDS_ANY_EQUAL = BAND_COLUMNS.map((column) => `${column} = ?`).join(" OR ");

/**
 * How many bands a row shares with a hash: `(band0 = ?) + ... + (band7 = ?)`.
 *
 * Pigeonhole again, and the stronger half of it: hashes at most D bits apart differ in at most
 * D bands, so they share at least `PHASH_BANDS - D`. Requiring that many is still exact -- no
 * pair within D is lost -- but it turns "shares a byte with", which a one-byte band makes true
 * of most of a library, into a filter that lets through little besides the real matches.
 */
const SHARED_BAND_COUNT = BAND_COLUMNS.map((column) => `(${column} = ?)`).join(" + ");

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

    db.transaction(() => {
        db.prepare(
            `INSERT INTO "PhashImage" ("mediaId", "hash", ${BAND_COLUMNS.join(", ")})
             VALUES (?, ?, ${bands.map(() => "?").join(", ")})
             ON CONFLICT("mediaId") DO UPDATE SET
                 "hash" = excluded."hash",
                 ${BAND_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`
        ).run(mediaId, Buffer.from(hash), ...bands);

        forgetClustered(mediaId);
    })();
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

        forgetClustered(mediaId);
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
 * Images whose hash could be within `distance` of this one.
 *
 * The band lookups find the rows sharing at least one band, which any pair within the indexed
 * distance must (§10); the shared-band count then keeps only those sharing the
 * `PHASH_BANDS - distance` that a pair within `distance` must. Both are necessary conditions,
 * so this is a superset of the true matches and the caller confirms each with an exact
 * Hamming distance.
 *
 * **No limit.** There used to be one, with no order, and at one-byte selectivity the union of
 * eight lookups outgrows it long before a library is large -- after which the pairs compared
 * were whichever rows SQLite happened to reach first. The shared-band filter is what makes
 * the result small enough not to need one.
 */
export const imageCandidates = (
    mediaId: string,
    hash: Uint8Array,
    distance: number
): PhashRow[] => {
    const bands = hashBands(hash);

    return (
        db
            .prepare(
                `SELECT "mediaId", "hash" FROM "PhashImage"
                  WHERE "mediaId" != ? AND (${BANDS_ANY_EQUAL}) AND ${SHARED_BAND_COUNT} >= ?`
            )
            .all(mediaId, ...bands, ...bands, PHASH_BANDS - distance) as {
            mediaId: string;
            hash: Buffer;
        }[]
    ).map((row) => ({ mediaId: row.mediaId, hash: new Uint8Array(row.hash) }));
};

/**
 * Videos that could pass `compareVideos` against these frames.
 *
 * A pair passes only if at least `minFrames` of the seed's frames each have a partner within
 * `distance`, and each such partner shares at least `PHASH_BANDS - distance` bands with its
 * seed frame. So the query finds, per seed frame, the rows sharing that many bands -- one
 * indexed lookup each -- and keeps the videos reached from `minFrames` distinct seed frames.
 * Every step is a necessary condition, so nothing that would match is lost.
 *
 * **No limit**, for the reason `imageCandidates` has none, only worse: twelve frames times
 * eight one-byte bands reached ~98% of the library's videos, and an unordered `LIMIT 200` then
 * kept an arbitrary 2.5% of them. Whether a real copy was ever compared was luck.
 *
 * Returns candidate *ids* rather than their frames. A candidate video's frames are fetched
 * only if it survives this filter, so the expensive half of the pass is spent on the few that
 * are worth it.
 */
export const videoCandidates = (
    mediaId: string,
    frameHashes: Uint8Array[],
    distance: number,
    minFrames: number
): string[] => {
    if (frameHashes.length === 0) {
        return [];
    }

    const lookups: string[] = [];
    const params: unknown[] = [];

    for (const [index, hash] of frameHashes.entries()) {
        const bands = hashBands(hash);

        lookups.push(
            `SELECT "mediaId", ${index} AS "seedFrame" FROM "PhashVideo"
              WHERE "mediaId" != ? AND (${BANDS_ANY_EQUAL}) AND ${SHARED_BAND_COUNT} >= ?`
        );
        params.push(mediaId, ...bands, ...bands, PHASH_BANDS - distance);
    }

    return (
        db
            .prepare(
                `SELECT "mediaId" FROM (${lookups.join(" UNION ALL ")})
                  GROUP BY "mediaId"
                 HAVING count(DISTINCT "seedFrame") >= ?
                  ORDER BY count(DISTINCT "seedFrame") DESC`
            )
            .all(...params, minFrames) as { mediaId: string }[]
    ).map((row) => row.mediaId);
};
