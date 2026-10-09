import { randomUUID } from "node:crypto";

import { db } from "../db.js";
import * as dupeRepo from "./dupeRepo.js";
import * as reelRepo from "./reelRepo.js";

/**
 * The recycle bin (§10, §18.1).
 *
 * Deleting is a per-user permission rather than an admin action, so it needs an audit trail
 * and an undo. These rows are both: the bin while the entry is open, and the record of who
 * removed what once it is closed — by a restore or by a purge, which are different endings
 * and are recorded as different columns.
 */

export interface TrashEntryRow {
    id: string;
    mediaId: string | null;
    fileId: string | null;
    rootId: string;
    relPath: string;
    trashRelPath: string;
    bytes: number;
    deletedById: string;
    deletedAt: string;
    movedAt: string | null;
    restoredAt: string | null;
    purgedAt: string | null;
    purgeAfter: string;
    /**
     * An identical file that stays, when there is one (§10e). Such an entry is not the bin's:
     * the trash job deletes the original outright and purges the item, and nothing restores
     * it. Null for an ordinary entry.
     */
    twinFileId: string | null;
}

export interface CreateTrashEntryInput {
    mediaId: string;
    fileId: string;
    rootId: string;
    relPath: string;
    trashRelPath: string;
    bytes: number;
    deletedById: string;
    retentionDays: number;
    /** See `TrashEntryRow.twinFileId`. */
    twinFileId: string | null;
}

export const findById = (id: string): TrashEntryRow | undefined =>
    db.prepare(`SELECT * FROM "TrashEntry" WHERE "id" = ?`).get(id) as TrashEntryRow | undefined;

/**
 * Records the deletion and takes the item out of the library, in one transaction.
 *
 * Both halves or neither. A TrashEntry without the state change leaves an item visible that
 * the app believes it deleted, and the state change without the entry leaves bytes in
 * /data/trash that nothing will ever purge or restore — an orphan that shows up only as disk
 * quietly disappearing.
 *
 * The state change is all the hiding that is needed: `Media.listable` is derived by trigger
 * from `MediaFile.state`, and every library query is already gated on it, so the item leaves
 * the grid, facets, counts, search and shuffle without one query knowing this feature exists.
 *
 * The item's queued and running work stops here too (`stopWorkFor`).
 *
 * **Every write transaction in this file is `immediate`**: it takes the write lock at `BEGIN`,
 * where `busy_timeout` applies. A deferred one that reads first has to upgrade midway, and
 * SQLite refuses that upgrade outright -- no waiting -- when the other process has committed
 * since the read began. Under a bulk deletion, with the worker purging as fast as the web
 * process trashes, that was one "database is locked" in thirty.
 */
export const create = (input: CreateTrashEntryInput): TrashEntryRow =>
    db
        .transaction((): TrashEntryRow => {
            const id = randomUUID();

            db.prepare(
                `INSERT INTO "TrashEntry"
                ("id", "mediaId", "fileId", "rootId", "relPath", "trashRelPath", "bytes",
                 "deletedById", "purgeAfter", "twinFileId")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)`
            ).run(
                id,
                input.mediaId,
                input.fileId,
                input.rootId,
                input.relPath,
                input.trashRelPath,
                input.bytes,
                input.deletedById,
                `+${input.retentionDays} days`,
                input.twinFileId
            );

            db.prepare(
                `UPDATE "MediaFile" SET "state" = 'trashed', "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ?`
            ).run(input.fileId);

            stopWorkFor(input.mediaId, input.fileId);

            return findById(id)!;
        })
        .immediate();

/** The jobs that move an entry's bytes. Everything else about a trashed item is moot. */
const BIN_KINDS = `('trash', 'restore', 'purge')`;

/**
 * Stops the processing queued or running against an item that has just been trashed.
 *
 * Nothing else would. The backfill already ignores unlisted items, but a probe, sprite or
 * transcode queued before the delete still ran: before the move it spent the NAS on an item in
 * the bin, and after it failed on the missing file — three times each, with every failure
 * counted against the item's stages, so a restored item came back settled as unprocessable.
 *
 * Pending rows are deleted rather than cancelled. Nothing reads a job that never started, and a
 * `cancelled` row is not neutral: `settledMediaIds` treats it as somebody deciding the item
 * should not be transcoded, which would outlive a restore. A claimed row has to be cancelled
 * instead, because that is how its runner finds out — the next heartbeat matches nothing and
 * the handler is aborted (§18.7). `forgetBinFailures` clears what that leaves behind.
 */
const stopWorkFor = (mediaId: string, fileId: string): void => {
    db.prepare(
        `DELETE FROM "Job"
          WHERE "state" = 'pending' AND ("mediaId" = ? OR "fileId" = ?)
            AND "kind" NOT IN ${BIN_KINDS}`
    ).run(mediaId, fileId);

    db.prepare(
        `UPDATE "Job"
            SET "state" = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "state" = 'claimed' AND ("mediaId" = ? OR "fileId" = ?)
            AND "kind" NOT IN ${BIN_KINDS}`
    ).run(mediaId, fileId);
};

/**
 * Forgets what went wrong with an item while it was in the bin, as it comes back out.
 *
 * A failure is evidence about a file, and a file that had been moved out of its library says
 * nothing about the one being restored. Left in place, these keep the item away from the sweep
 * for good: a stage at its attempt limit is never offered again, and a cancelled or failed
 * transcode is read by `settledMediaIds` as a decision. What the item had settled *before* it
 * was trashed is kept, since that is still true of the same bytes.
 *
 * Timestamps compare as text, and every one of these is SQLite's own `CURRENT_TIMESTAMP`, so the
 * formats agree. A genuine failure in the same second as the delete is forgotten with the rest,
 * which costs at most one more attempt.
 */
const forgetBinFailures = (entry: TrashEntryRow): void => {
    if (!entry.mediaId) {
        return;
    }

    db.prepare(
        `DELETE FROM "MediaStage" WHERE "mediaId" = ? AND "state" = 'failed' AND "at" >= ?`
    ).run(entry.mediaId, entry.deletedAt);

    db.prepare(
        `DELETE FROM "Job"
          WHERE ("mediaId" = ? OR "fileId" = ?)
            AND "state" IN ('failed', 'cancelled')
            AND "kind" NOT IN ${BIN_KINDS}
            AND "finishedAt" >= ?`
    ).run(entry.mediaId, entry.fileId, entry.deletedAt);
};

/** The open entry for a file, if it has one. Restoring twice is not a second restore. */
export const findOpenForFile = (fileId: string): TrashEntryRow | undefined =>
    db
        .prepare(
            `SELECT * FROM "TrashEntry" WHERE "fileId" = ? AND "restoredAt" IS NULL AND "purgedAt" IS NULL`
        )
        .get(fileId) as TrashEntryRow | undefined;

export interface TrashListRow extends TrashEntryRow {
    title: string | null;
    kind: "image" | "video" | null;
    rootLabel: string;
    deletedBy: string;
    fileState: string | null;
    coverPath: string | null;
    coverGeneratedAt: string | null;
}

/**
 * What is currently in the bin, newest first.
 *
 * Joined rather than fetched per row: these are items that no longer exist in the library, so
 * the ordinary detail path cannot serve them and one request per entry would be the only
 * alternative.
 */
export const listPending = (limit: number, offset: number): TrashListRow[] =>
    db
        .prepare(
            `SELECT t.*, m."title", m."kind", r."label" AS "rootLabel",
                    u."displayName" AS "deletedBy", f."state" AS "fileState",
                    a."relPath" AS "coverPath", a."generatedAt" AS "coverGeneratedAt"
               FROM "TrashEntry" t
               JOIN "MediaRoot" r ON r."id" = t."rootId"
               JOIN "User" u ON u."id" = t."deletedById"
               LEFT JOIN "Media" m ON m."id" = t."mediaId"
               LEFT JOIN "MediaFile" f ON f."id" = t."fileId"
               LEFT JOIN "Artifact" a
                      ON a."mediaId" = t."mediaId" AND a."kind" = 'cover'
              WHERE t."restoredAt" IS NULL AND t."purgedAt" IS NULL AND t."twinFileId" IS NULL
              ORDER BY t."deletedAt" DESC, t."id"
              LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as TrashListRow[];

/**
 * Bytes the bin is holding on /data, which is what decides whether to purge early.
 *
 * Not an entry with a twin (§10e): its bytes are deleted outright, never copied into the bin,
 * so counting them would put a figure on the trash page that emptying it could not free.
 */
export const heldBytes = (): number =>
    (
        db
            .prepare(
                `SELECT COALESCE(sum("bytes"), 0) AS n FROM "TrashEntry"
                  WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL AND "twinFileId" IS NULL`
            )
            .get() as { n: number }
    ).n;

/**
 * Bytes the bin owes /data: entries accepted whose files have not been copied across yet.
 *
 * What the free-space check has to add to the file it is asked about. The volume's free space
 * only shrinks once a move lands, so a bulk deletion that checked each file against it alone
 * would pass every one — two hundred 3 GB copies against 50 GB free — and then fill the volume
 * holding the database while the queue drained. A move half-way through is counted in full as
 * well as in what it has already written, which errs towards refusing, the safe side.
 *
 * An entry with a twin owes nothing: its original is deleted outright (§10e).
 */
export const unmovedBytes = (): number =>
    (
        db
            .prepare(
                `SELECT COALESCE(sum("bytes"), 0) AS n FROM "TrashEntry"
                  WHERE "movedAt" IS NULL AND "restoredAt" IS NULL AND "purgedAt" IS NULL
                    AND "twinFileId" IS NULL`
            )
            .get() as { n: number }
    ).n;

export const countPending = (): number =>
    (
        db
            .prepare(
                `SELECT count(*) AS n FROM "TrashEntry"
                  WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL AND "twinFileId" IS NULL`
            )
            .get() as {
            n: number;
        }
    ).n;

/**
 * Entries whose window has closed.
 *
 * `fileState` comes back so the caller can refuse to purge something that is no longer
 * trashed. That happens when a file reappears at its old path and a scan revives the row —
 * rare, but the failure mode is destroying an item the library is actively showing, which is
 * the one outcome this feature must never produce.
 */
export const listPurgeable = (limit: number): TrashListRow[] =>
    db
        .prepare(
            `SELECT t.*, m."title", m."kind", r."label" AS "rootLabel",
                    u."displayName" AS "deletedBy", f."state" AS "fileState",
                    NULL AS "coverPath", NULL AS "coverGeneratedAt"
               FROM "TrashEntry" t
               JOIN "MediaRoot" r ON r."id" = t."rootId"
               JOIN "User" u ON u."id" = t."deletedById"
               LEFT JOIN "Media" m ON m."id" = t."mediaId"
               LEFT JOIN "MediaFile" f ON f."id" = t."fileId"
              WHERE t."restoredAt" IS NULL AND t."purgedAt" IS NULL AND t."twinFileId" IS NULL
                AND t."purgeAfter" <= CURRENT_TIMESTAMP
              ORDER BY t."purgeAfter"
              LIMIT ?`
        )
        .all(limit) as TrashListRow[];

/**
 * Closes an entry and brings its file back.
 *
 * Marking the entry restored is what makes restore idempotent — the row leaves every pending
 * query at once, so a second restore finds nothing rather than copying bytes over a file that
 * is already back.
 */
export const markRestored = (id: string): void => {
    db.transaction((): void => {
        const entry = findById(id);

        if (!entry) {
            return;
        }

        db.prepare(`UPDATE "TrashEntry" SET "restoredAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(
            id
        );

        if (entry.fileId) {
            db.prepare(
                `UPDATE "MediaFile"
                    SET "state" = 'active', "missingScans" = 0, "updatedAt" = CURRENT_TIMESTAMP
                  WHERE "id" = ?`
            ).run(entry.fileId);
        }

        forgetBinFailures(entry);

        // A duplicate back in the library is a duplicate to decide about again.
        if (entry.mediaId) {
            dupeRepo.reopenGroupsOf(entry.mediaId);
        }
    }).immediate();
};

/**
 * Closes an entry because the file came back on its own.
 *
 * A person can put the file back with a file manager, and the next scan finds it and revives
 * the row. Without this the entry would sit there until its window closed and the purge would
 * delete an item the library is showing — so the scan path resolves the entry at the moment
 * it revives the file, rather than leaving the contradiction for the destructive step to
 * discover.
 *
 * Whether the file really is back is `mediaFileRepo.upsertSeen`'s decision, not this one's: an
 * original still waiting for its move is at the old path too, and only that function has what
 * it takes to tell the two apart. Call this only when it reports `revivedFromTrash`.
 */
export const markRestoredByFile = (fileId: string): boolean =>
    db
        .transaction((): boolean => {
            const entry = findOpenForFile(fileId);

            if (!entry) {
                return false;
            }

            db.prepare(
                `UPDATE "TrashEntry" SET "restoredAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
            ).run(entry.id);

            forgetBinFailures(entry);

            // A duplicate obtained again at its old path is a duplicate to decide about again.
            if (entry.mediaId) {
                dupeRepo.reopenGroupsOf(entry.mediaId);
            }

            return true;
        })
        .immediate();

/**
 * The irreversible half: the item and its physical row go, the audit row stays.
 *
 * Deleting Media cascades to tags, ratings, stage records, hashes and artifact rows, which is
 * the point — at this moment the item is genuinely gone. `TrashEntry.mediaId` is
 * ON DELETE SET NULL, so this entry survives as the record of what was removed and by whom,
 * which is the only thing left to know.
 *
 * **It also cascades to clips, and through them into the middle of somebody's reel** (§14d).
 * That is the intended outcome — §10c deliberately does not move a timecode onto a surviving
 * near-duplicate, because a different encode has a different timeline and the span would point
 * at the wrong frames — but it takes `ReelItem` rows out without going through
 * `reelRepo.removeItem`, so the positions stop being dense and "3 of 12" becomes a number that
 * can exceed twelve. The affected reels are collected **before** the delete, while there is
 * still a clip to join through, and renumbered after it inside this same transaction.
 */
export const purge = (id: string): void => {
    db.transaction((): void => {
        const entry = findById(id);

        if (!entry) {
            return;
        }

        if (entry.mediaId) {
            const shortened = reelRepo.reelIdsHoldingMedia(entry.mediaId);

            db.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run(entry.mediaId);

            for (const reelId of shortened) {
                reelRepo.renumber(reelId);
            }
        }

        if (entry.fileId) {
            db.prepare(`DELETE FROM "MediaFile" WHERE "id" = ?`).run(entry.fileId);
        }

        // Kept, deliberately: "purged" is not the same as "never happened", and it is not the
        // same as "restored" either — which is the whole reason this has its own column.
        db.prepare(`UPDATE "TrashEntry" SET "purgedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(id);
    }).immediate();
};

/**
 * Queues the byte movement for an entry.
 *
 * The entry id rides in `payloadJson` because the queue deduplicates on
 * (kind, mediaId, fileId) and those are not enough on their own: a file trashed, restored and
 * trashed again is two entries for one file, and the job has to know which one it is acting
 * on.
 *
 * Priority 30 puts these ahead of ordinary processing. Someone is waiting, the work is I/O
 * rather than CPU, and a deletion that visibly has not happened yet is the kind of thing
 * people click twice.
 *
 * Refusing quietly is deliberate, and there are two ways it happens: this entry already has a
 * live job, or the queue's own unique index already holds one for this file. The second is
 * the interesting one — a file trashed, restored and trashed again while the first move is
 * still queued — and it must not turn a delete request into an error. `sweepUnmovedTrash`
 * picks the entry up once the queue is clear, which is also what recovers a move lost to a
 * killed container.
 */
export const enqueueMove = (
    kind: "trash" | "restore" | "purge",
    entryId: string,
    mediaId: string | null,
    fileId: string | null
): void => {
    db.prepare(
        `INSERT INTO "Job"
             ("id", "kind", "mediaId", "fileId", "payloadJson", "priority", "updatedAt")
         SELECT ?, ?, ?, ?, ?, 30, CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
              SELECT 1 FROM "Job"
               WHERE "kind" = ? AND "payloadJson" = ?
                 AND "state" IN ('pending', 'claimed')
          )
         ON CONFLICT DO NOTHING`
    ).run(
        randomUUID(),
        kind,
        mediaId,
        fileId,
        JSON.stringify({ entryId }),
        kind,
        JSON.stringify({ entryId })
    );
};

/** The bytes are in the bin; the entry is settled until someone restores or purges it. */
export const markMoved = (id: string): void => {
    db.prepare(`UPDATE "TrashEntry" SET "movedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(id);
};

/**
 * Open entries whose bytes have not moved yet.
 *
 * The self-healing half of trashing. A move can be lost — a killed container, or an enqueue
 * the queue refused because another job for that file was still live — and the entry is the
 * only record that the file is still sitting in a media root the app believes it emptied.
 * Nothing else would ever notice.
 */
export const listAwaitingMove = (limit: number): TrashEntryRow[] =>
    db
        .prepare(
            `SELECT t.* FROM "TrashEntry" t
              WHERE t."movedAt" IS NULL
                AND t."restoredAt" IS NULL AND t."purgedAt" IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM "Job" j
                     WHERE j."kind" = 'trash' AND j."fileId" = t."fileId"
                       AND j."state" IN ('pending', 'claimed')
                )
              ORDER BY t."deletedAt"
              LIMIT ?`
        )
        .all(limit) as TrashEntryRow[];

/** The entry a move job is acting on, resolved from its payload. */
export const findForJob = (payloadJson: string | null): TrashEntryRow | undefined => {
    if (!payloadJson) {
        return undefined;
    }

    try {
        const payload = JSON.parse(payloadJson) as { entryId?: unknown };

        return typeof payload.entryId === "string" ? findById(payload.entryId) : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The current state of a physical row, for the purge guard.
 *
 * Read at the moment of purging rather than carried on the entry, because the whole point is
 * to catch a change that happened after the entry was written.
 */
export const fileStateOf = (fileId: string): string | null => {
    const row = db.prepare(`SELECT "state" FROM "MediaFile" WHERE "id" = ?`).get(fileId) as
        { state: string } | undefined;

    return row?.state ?? null;
};

/**
 * Another active file with the same bytes as this one, whose presence means this one can be
 * deleted outright rather than trashed (§10e).
 *
 * `contentHash` is the whole file (§5), so equal hashes are equal bytes. The file linked to
 * `preferMediaId` comes first when it qualifies -- the copy the merge hands everything to
 * (§10c). When a whole group is being deleted best-last (§10d), that is the copy still waiting
 * its turn, whose own bytes go to the bin, so the content survives there.
 */
export const findIdenticalActiveFile = (
    fileId: string,
    preferMediaId: string | null
): string | null => {
    const row = db
        .prepare(
            `SELECT other."id"
               FROM "MediaFile" f
               JOIN "MediaFile" other
                 ON other."contentHash" = f."contentHash" AND other."id" <> f."id"
               LEFT JOIN "MediaFileLink" fl
                 ON fl."fileId" = other."id" AND fl."role" = 'original'
              WHERE f."id" = ? AND f."contentHash" IS NOT NULL AND other."state" = 'active'
              ORDER BY CASE WHEN fl."mediaId" = ? THEN 0 ELSE 1 END, other."id"
              LIMIT 1`
        )
        .get(fileId, preferMediaId) as { id: string } | undefined;

    return row?.id ?? null;
};

/**
 * The entry becomes an ordinary one after all (§10e).
 *
 * The trash job's way out when the twin can no longer vouch for the bytes -- changed on disk,
 * or gone -- so deleting the original outright could lose the content. It is copied into the
 * bin instead, and from here it is listed, counted and restorable like any other entry.
 * Cleared before the copy, so the bin's accounting counts the bytes it is about to receive.
 */
export const clearTwin = (id: string): void => {
    db.prepare(`UPDATE "TrashEntry" SET "twinFileId" = NULL WHERE "id" = ?`).run(id);
};

export type OpenEntryRow = Pick<
    TrashEntryRow,
    "id" | "mediaId" | "fileId" | "movedAt" | "bytes" | "twinFileId"
>;

/**
 * Every open entry in the bin, oldest first, for emptying it at once. Not an identical copy's
 * (§10e), which is deleted by its own job and was never the bin's to empty.
 *
 * `movedAt` comes back because an entry whose original is still in the media root must not be
 * purged: that would delete the catalogue row and leave the file for the next scan to adopt as
 * something new. The caller leaves those for their move to finish.
 */
export const listOpen = (): OpenEntryRow[] =>
    db
        .prepare(
            `SELECT "id", "mediaId", "fileId", "movedAt", "bytes", "twinFileId"
               FROM "TrashEntry"
              WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL AND "twinFileId" IS NULL
              ORDER BY "deletedAt", "id"`
        )
        .all() as OpenEntryRow[];
