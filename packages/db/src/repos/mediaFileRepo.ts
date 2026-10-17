import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * Physical files.
 *
 * The scan path is the hottest write path in the app — a 200k-item rescan touches every row
 * — so these statements are deliberately narrow and indexed (§20: a rescan of an unchanged
 * library must stay stat-only).
 */

export interface MediaFileRow {
    id: string;
    rootId: string;
    relPath: string;
    size: number;
    mtime: number;
    dev: string | null;
    inode: string | null;
    quickHash: string | null;
    contentHash: string | null;
    state: "active" | "missing" | "archived" | "trashed" | "unverified";
    classification: "media" | "companion" | "ignored";
    missingScans: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

export const findByPath = (rootId: string, relPath: string): MediaFileRow | undefined =>
    db
        .prepare(`SELECT * FROM "MediaFile" WHERE "rootId" = ? AND "relPath" = ?`)
        .get(rootId, relPath) as MediaFileRow | undefined;

export const findById = (id: string): MediaFileRow | undefined =>
    db.prepare(`SELECT * FROM "MediaFile" WHERE "id" = ?`).get(id) as MediaFileRow | undefined;

/**
 * The files a scan has confirmed without writing to them.
 *
 * An unchanged rescan used to rewrite every row it saw — `lastSeenAt` was how reconciliation
 * told seen from unseen — and `MediaFile_list_au` then rewrote the matching `Media` row as
 * well. So a scan that found nothing new pushed the whole catalogue through the WAL in two
 * commits per 200 files, and every one of those commits emptied the web process's page cache
 * (in WAL mode a reader discards its cache whenever another connection has committed). The
 * measured result was primary-key lookups in the web process at 0.3–1.5 s while a scan ran (§20).
 *
 * A TEMP table, because temp tables live in the connection's own temp database: nothing here
 * reaches the main file or its WAL, so recording ten thousand confirmations commits nothing
 * another process can see. It vanishes with the connection, which is also the right lifetime —
 * a scan interrupted by a crash leaves nothing behind to be mistaken for the next one's.
 *
 * Keyed by scan so two scans on one connection cannot read each other's confirmations.
 */
export const beginScanSeen = (scanId: string): void => {
    db.exec(
        `CREATE TEMP TABLE IF NOT EXISTS "ScanSeen" (
            "scanId" TEXT NOT NULL,
            "fileId" TEXT NOT NULL,
            PRIMARY KEY ("scanId", "fileId")
        ) WITHOUT ROWID`
    );
    db.prepare(`DELETE FROM temp."ScanSeen" WHERE "scanId" = ?`).run(scanId);
};

/** Drop a finished scan's confirmations. Only valid after `beginScanSeen`. */
export const endScanSeen = (scanId: string): void => {
    db.prepare(`DELETE FROM temp."ScanSeen" WHERE "scanId" = ?`).run(scanId);
};

/**
 * "Not seen by this scan", in SQL: neither written by it nor confirmed into `ScanSeen`.
 *
 * Both halves, because a scan still writes the rows that changed — new, modified, revived,
 * moved — and those carry a fresh `lastSeenAt` instead of a confirmation. Callers bind the
 * scan's start timestamp and then its id, in that order.
 */
const UNSEEN_BY_SCAN = `"lastSeenAt" < ?
    AND "id" NOT IN (SELECT "fileId" FROM temp."ScanSeen" WHERE "scanId" = ?)`;

export interface UpsertFileInput {
    /** The scan doing the seeing — see `beginScanSeen`, which must have been called for it. */
    scanId: string;
    rootId: string;
    relPath: string;
    size: number;
    mtime: number;
    dev: string | null;
    inode: string | null;
    classification: "media" | "companion" | "ignored";
    /**
     * Whether the path is occupied at this moment, asked only of a trashed row whose bytes
     * have already gone to the bin. See `hasComeBackFromTrash` for why the scan's own `stat`
     * is not enough. Must be synchronous: it is called inside the batch's transaction.
     */
    isOnDiskNow?: () => boolean;
}

export interface UpsertResult {
    file: MediaFileRow;
    /** "created" and "changed" are the rows that need reprocessing; "seen" is the cheap path. */
    outcome: "created" | "changed" | "seen";
    /**
     * The row had been trashed and the file is back at its old path.
     *
     * Reported rather than handled here, because the caller owns the trash entry that now
     * contradicts reality. Left unresolved, that entry keeps its retention window and the
     * purge eventually destroys an item the library is showing (§10).
     */
    revivedFromTrash: boolean;
}

/**
 * Whether a trashed file the scan has just seen is genuinely back, rather than not yet gone.
 *
 * Trashing hides the row at once and moves the bytes later, in a job (§10). Until that job
 * lands, the file is still at its old path, and a scan walking past it used to read that as
 * somebody restoring it by hand: the row went back to `active`, the scanner closed the trash
 * entry, and the move job then found a restored entry and did nothing. The deletion was undone
 * without anyone asking, after its ratings and tags had already been merged away (§10c).
 *
 * So an entry whose bytes have not moved answers no — unless the file at the path is no longer
 * the one catalogued. That is the case the move job refuses to touch ("rescan the library and
 * try again"), and reviving the row is exactly the rescan it asks for: the new bytes come back
 * as the item, and the entry is closed rather than retried for ever. One whose bytes have moved still asks the
 * filesystem again, because the scan's `stat` came before this transaction: the move can have
 * copied and unlinked the file in between, and the stale sighting would then revive a row whose
 * file is in the bin. The worker is single-threaded and this runs synchronously, so `movedAt`
 * cannot be written while it runs, and it is only written after the unlink has completed —
 * which makes a fresh look at the path, taken here, the truth.
 *
 * A trashed row with no open entry is revived as before: nothing is waiting on it.
 */
const hasComeBackFromTrash = (existing: MediaFileRow, input: UpsertFileInput): boolean => {
    const entry = db
        .prepare(
            `SELECT "movedAt" FROM "TrashEntry"
              WHERE "fileId" = ? AND "restoredAt" IS NULL AND "purgedAt" IS NULL`
        )
        .get(existing.id) as { movedAt: string | null } | undefined;

    if (!entry) {
        return true;
    }

    if (entry.movedAt === null) {
        return existing.size !== input.size || existing.mtime !== input.mtime;
    }

    return input.isOnDiskNow?.() ?? true;
};

/**
 * Record that a file was seen, and report whether it is new or modified.
 *
 * `(size, mtime)` is the change signal — content hashing every file on every scan would make
 * a rescan unusable over SMB. A file whose size and mtime are unchanged is assumed
 * unchanged, which is the same bet every backup tool makes.
 */
export const upsertSeen = (input: UpsertFileInput): UpsertResult => {
    const existing = findByPath(input.rootId, input.relPath);

    if (!existing) {
        const id = randomUUID();
        db.prepare(
            `INSERT INTO "MediaFile"
                ("id", "rootId", "relPath", "size", "mtime", "dev", "inode", "classification",
                 "lastSeenAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).run(
            id,
            input.rootId,
            input.relPath,
            input.size,
            input.mtime,
            input.dev,
            input.inode,
            input.classification
        );

        return { file: findById(id)!, outcome: "created", revivedFromTrash: false };
    }

    if (existing.state === "trashed" && !hasComeBackFromTrash(existing, input)) {
        // Left exactly as it is. Reconciliation skips trashed rows, so there is nothing to
        // confirm either.
        return { file: existing, outcome: "seen", revivedFromTrash: false };
    }

    const changed = existing.size !== input.size || existing.mtime !== input.mtime;

    /**
     * Nothing to write, so nothing is written: the confirmation goes to the scan's temp table
     * instead (see `beginScanSeen`). Every column the UPDATE below would set has to already hold
     * its value — a file that came back from missing or from the trash, or whose identity or
     * classification moved, still takes the write, because the row then says something new.
     */
    const unchanged =
        !changed &&
        existing.dev === input.dev &&
        existing.inode === input.inode &&
        existing.classification === input.classification &&
        existing.state === "active" &&
        existing.missingScans === 0;

    if (unchanged) {
        db.prepare(`INSERT OR IGNORE INTO temp."ScanSeen" ("scanId", "fileId") VALUES (?, ?)`).run(
            input.scanId,
            existing.id
        );

        return { file: existing, outcome: "seen", revivedFromTrash: false };
    }

    db.prepare(
        `UPDATE "MediaFile"
            SET "size" = ?, "mtime" = ?, "dev" = ?, "inode" = ?, "classification" = ?,
                "state" = 'active', "missingScans" = 0,
                "lastSeenAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP,
                "quickHash" = CASE WHEN ? THEN NULL ELSE "quickHash" END,
                "contentHash" = CASE WHEN ? THEN NULL ELSE "contentHash" END
          WHERE "id" = ?`
    ).run(
        input.size,
        input.mtime,
        input.dev,
        input.inode,
        input.classification,
        changed ? 1 : 0,
        changed ? 1 : 0,
        existing.id
    );

    return {
        file: findById(existing.id)!,
        outcome: changed ? "changed" : "seen",
        revivedFromTrash: existing.state === "trashed",
    };
};

export interface MoveCandidateInput {
    rootId: string;
    dev: string | null;
    inode: string | null;
    size: number;
    mtime: number;
    /**
     * Rows this scan has already placed are where they belong and are poor candidates.
     *
     * Compared with `<=` rather than `<` because SQLite's CURRENT_TIMESTAMP has one-second
     * resolution: two scans inside the same second share a timestamp, and a strict comparison
     * then excludes every row the previous scan wrote — which silently turns move detection
     * off. The filter is only an optimisation in any case; the caller's proof is that the old
     * path has gone from disk, and a row that is genuinely still in place fails that.
     */
    scanStartedAt: string;
    /** And rows it confirmed without writing (`beginScanSeen`) are placed just the same. */
    scanId: string;
}

/**
 * The file a newly seen path might be, moved (§7).
 *
 * Without this, renaming a directory is indistinguishable from deleting every file in it and
 * creating new ones — which costs the tags, ratings, watch positions and processing history
 * attached to the old items and hands back a set of blank new ones. For a cataloguer that is
 * the expensive kind of wrong, and reorganising folders is a normal thing to do.
 *
 * Identity is `(dev, inode)`, which a rename preserves on every filesystem worth using —
 * verified on NTFS as well as POSIX. Size must agree too, because inode numbers are reused
 * once a file is deleted, and an unrelated new file inheriting one would otherwise look like
 * a move.
 *
 * **Exactly one candidate, or none.** Two matches mean the evidence does not identify a
 * single file, and a wrong merge silently attaches one file's history to another — worse
 * than missing the move, which merely costs what the old behaviour cost anyway.
 */
export const findMoveCandidate = (input: MoveCandidateInput): MediaFileRow | undefined => {
    const rows =
        input.inode !== null
            ? (db
                  .prepare(
                      `SELECT * FROM "MediaFile"
                        WHERE "rootId" = ? AND "inode" = ? AND "size" = ?
                          AND "dev" IS ?
                          AND "state" IN ('active', 'missing', 'unverified')
                          AND "lastSeenAt" <= ?
                          AND "id" NOT IN (
                              SELECT "fileId" FROM temp."ScanSeen" WHERE "scanId" = ?)
                        LIMIT 2`
                  )
                  .all(
                      input.rootId,
                      input.inode,
                      input.size,
                      input.dev,
                      input.scanStartedAt,
                      input.scanId
                  ) as MediaFileRow[])
            : /**
               * No usable inode — FAT32, some SMB shares.
               *
               * Size and mtime together are a far weaker claim, so this is only reached when
               * the filesystem refuses to answer the better question. The caller still checks
               * that the old path has gone, which is what keeps it honest.
               */
              (db
                  .prepare(
                      `SELECT * FROM "MediaFile"
                        WHERE "rootId" = ? AND "inode" IS NULL
                          AND "size" = ? AND "mtime" = ?
                          AND "state" IN ('active', 'missing', 'unverified')
                          AND "lastSeenAt" <= ?
                          AND "id" NOT IN (
                              SELECT "fileId" FROM temp."ScanSeen" WHERE "scanId" = ?)
                        LIMIT 2`
                  )
                  .all(
                      input.rootId,
                      input.size,
                      input.mtime,
                      input.scanStartedAt,
                      input.scanId
                  ) as MediaFileRow[]);

    return rows.length === 1 ? rows[0] : undefined;
};

/**
 * Records that a file is now at a different path inside the same library.
 *
 * One row updated rather than one created and one abandoned, so everything that hangs off it
 * — the item, its tags, its rating, its perceptual hash, its processing history — simply
 * follows the file. The list columns are recomputed by trigger, so the grid shows the new
 * path without anything else being told.
 */
export const recordMove = (fileId: string, relPath: string): void => {
    db.prepare(
        `UPDATE "MediaFile"
            SET "relPath" = ?, "state" = 'active', "missingScans" = 0,
                "lastSeenAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(relPath, fileId);
};

/**
 * Mark everything not seen by this scan.
 *
 * Deliberately not a delete. A share that was offline during a scan must not cost the user
 * their ratings and tags (§7), so rows accumulate `missingScans` and are only archived after
 * several consecutive misses.
 *
 * **Trashed rows are excluded.** Their file is absent because someone deleted it, so a scan
 * would otherwise "discover" every deletion as a missing file. That would overwrite the one
 * piece of state the recycle bin depends on, and turn a user decision back into a filesystem
 * accident — including for any future sweep that reaps what has been missing too long.
 *
 * **`pathPrefix` is mandatory for subtree scans, and getting it wrong is destructive.** A
 * watcher-triggered scan of one directory sees only that directory's files, so reconciling
 * against the whole root would mark every *other* file in the library missing. The prefix
 * confines the sweep to what the scan actually looked at.
 */
export const markMissingAfterScan = (
    rootId: string,
    scanId: string,
    scanStartedAt: string,
    pathPrefix?: string
): number => {
    const scoped = pathPrefix !== undefined && pathPrefix !== "";

    return db
        .prepare(
            `UPDATE "MediaFile"
                SET "state" = CASE WHEN "missingScans" + 1 >= 3 THEN 'archived' ELSE 'missing' END,
                    "missingScans" = "missingScans" + 1,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "rootId" = ?
                AND ${UNSEEN_BY_SCAN}
                AND "state" NOT IN ('archived', 'trashed')
                ${scoped ? `AND "relPath" LIKE ? ESCAPE '\\'` : ""}`
        )
        .run(
            ...(scoped
                ? [rootId, scanStartedAt, scanId, `${pathPrefix.replace(/[%_\\]/g, "\\$&")}/%`]
                : [rootId, scanStartedAt, scanId])
        ).changes;
};

/**
 * Files awaiting confirmation after a repoint.
 *
 * Surfaced so the admin page can say "verifying" rather than leaving a library that has just
 * emptied itself looking like a library that lost everything.
 */
export const countUnverifiedByRoot = (rootId: string): number =>
    (
        db
            .prepare(
                `SELECT count(*) AS n FROM "MediaFile"
                  WHERE "rootId" = ? AND "state" = 'unverified'`
            )
            .get(rootId) as { n: number }
    ).n;

export const countByRoot = (rootId: string): number =>
    (
        db
            .prepare(
                `SELECT count(*) AS n FROM "MediaFile" WHERE "rootId" = ? AND "state" = 'active'`
            )
            .get(rootId) as { n: number }
    ).n;

/**
 * Records the identity hashes (§5).
 *
 * Either may be null: `quickHash` is computed for every file, `contentHash` only where a
 * quick collision makes the expensive answer worth having. Passing null for `contentHash`
 * leaves any existing value alone rather than clearing it, so the cheap job does not undo
 * the expensive one.
 *
 * A content hash that is new to the file also un-marks its item for clustering, for the reason
 * `phashRepo` forgets the mark on a perceptual hash (§10b): an item compared before it had one
 * was not compared for exact duplicates, and nobody else would find the pair.
 */
export const setHashes = (
    fileId: string,
    quickHash: string | null,
    contentHash: string | null
): void => {
    db.transaction(() => {
        const changed =
            contentHash !== null &&
            db
                .prepare(
                    `SELECT 1 FROM "MediaFile"
                      WHERE "id" = ? AND "contentHash" IS NOT ?`
                )
                .get(fileId, contentHash) !== undefined;

        db.prepare(
            `UPDATE "MediaFile"
                SET "quickHash" = COALESCE(?, "quickHash"),
                    "contentHash" = COALESCE(?, "contentHash"),
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ?`
        ).run(quickHash, contentHash, fileId);

        if (changed) {
            db.prepare(
                `DELETE FROM "DupeClustered"
                  WHERE "mediaId" IN (SELECT "mediaId" FROM "MediaFileLink"
                                       WHERE "fileId" = ? AND "role" = 'original')`
            ).run(fileId);
        }
    })();
};

/**
 * Other items whose original is byte-identical to this file and still in the library (§10f).
 *
 * Proven by `contentHash`, never by the quick hash: a collision on that is only a reason to
 * look closer, and an item that borrowed artifacts on the strength of one would show another
 * file's pictures. The scanner clears both hashes when a file's size or mtime changes, so a
 * stored content hash describes the bytes as they were last seen.
 */
export const identicalMediaIds = (fileId: string): string[] =>
    (
        db
            .prepare(
                `SELECT DISTINCT fl."mediaId"
                   FROM "MediaFile" me
                   JOIN "MediaFile" f
                     ON f."contentHash" = me."contentHash" AND f."id" != me."id"
                   JOIN "MediaFileLink" fl ON fl."fileId" = f."id" AND fl."role" = 'original'
                  WHERE me."id" = ? AND me."contentHash" IS NOT NULL AND f."state" = 'active'
                    AND fl."mediaId" NOT IN
                        (SELECT "mediaId" FROM "MediaFileLink" WHERE "fileId" = me."id")`
            )
            .all(fileId) as { mediaId: string }[]
    ).map((row) => row.mediaId);

/**
 * Other active files sharing a quick hash, with whatever content hash each already has.
 *
 * This is the trigger for the expensive pass: a quick collision means the files *might* be
 * identical, and only then is reading them end to end justified. A peer that already has a
 * content hash need not be read again — the scanner clears both hashes when a file's size or
 * mtime changes, so a stored one still describes the file.
 */
export const quickHashPeers = (
    fileId: string,
    quickHash: string
): { id: string; rootId: string; relPath: string; contentHash: string | null }[] =>
    db
        .prepare(
            `SELECT "id", "rootId", "relPath", "contentHash" FROM "MediaFile"
              WHERE "quickHash" = ? AND "id" != ? AND "state" = 'active'`
        )
        .all(quickHash, fileId) as {
        id: string;
        rootId: string;
        relPath: string;
        contentHash: string | null;
    }[];
