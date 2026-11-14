import {
    AuthorizationError,
    ConflictError,
    DEFAULT_TRASH_SETTINGS,
    NotFoundError,
    ReadOnlyRootError,
    SETTING_KEYS,
    trashSettingsSchema,
    type EmptyTrashResponse,
    type TrashEntry,
    type TrashListResponse,
    type TrashSettings,
} from "@private-stock/core";
import { changeLogRepo, db, mediaRepo, settingRepo, trashRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { whenNotBusy } from "../whenNotBusy";
import { coverUrl } from "./artService";
import { clearLibraryCaches } from "./libraryService";
import { mergeIntoSurvivingCopy, type MergeOutcome } from "./mergeService";

/**
 * The recycle bin (§10, §18.1).
 *
 * Two decisions separated by a retention window. Trashing needs the `delete` scope and a
 * writable root; restoring and purging are admin-only, because undoing someone else's
 * deletion and destroying it for good are both decisions about the library rather than about
 * one item.
 */

export const loadTrashSettings = (): TrashSettings => {
    const parsed = trashSettingsSchema.safeParse({
        retentionDays: settingRepo.get(
            SETTING_KEYS.trashRetention,
            DEFAULT_TRASH_SETTINGS.retentionDays
        ),
    });

    // A setting edited to nonsense must not disable deletion; the default is always valid.
    return parsed.success ? parsed.data : DEFAULT_TRASH_SETTINGS;
};

const requireAdmin = (auth: AuthContext, action: string): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError(`Only an administrator can ${action}`);
    }
};

interface DeletableRow {
    fileId: string;
    rootId: string;
    relPath: string;
    size: number;
    writable: number | null;
    state: string;
}

/**
 * The original file behind an item, with everything deletion has to check.
 *
 * One query rather than three lookups: every field here is part of a single decision, and
 * fetching them separately would make it possible to check the root's writability against a
 * different row than the one being deleted.
 */
const loadDeletable = (mediaId: string): DeletableRow | undefined =>
    db
        .prepare(
            `SELECT f."id" AS "fileId", f."rootId", f."relPath", f."size",
                    r."writable", f."state"
               FROM "MediaFileLink" fl
               JOIN "MediaFile" f ON f."id" = fl."fileId"
               JOIN "MediaRoot" r ON r."id" = f."rootId"
              WHERE fl."mediaId" = ? AND fl."role" = 'original'`
        )
        .get(mediaId) as DeletableRow | undefined;

export interface TrashResult {
    entryId: string;
    /**
     * Where this item's ratings, tags and playlist slots went, when it was a duplicate of
     * something still in the library (§10c). Null when it was not.
     */
    merged: MergeOutcome | null;
}

/**
 * Moves an item to the bin.
 *
 * A catalogue change only: the item leaves the library inside `trashRepo.create`'s
 * transaction, and its file stays at its path until the purge unlinks it there (§10). Nothing
 * is copied, so there is no space to check and no job to wait for -- except for an identical
 * copy, whose outright delete is a job (§10e).
 */
export const trashMedia = async (mediaId: string, auth: AuthContext): Promise<TrashResult> => {
    if (!auth.scopes.includes("delete")) {
        throw new AuthorizationError("You do not have permission to delete files");
    }

    // The same visibility rule as the library: what you cannot see, you cannot delete.
    if (!mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds)) {
        throw new NotFoundError("Media not found");
    }

    const target = loadDeletable(mediaId);

    if (!target) {
        throw new NotFoundError("Media has no original file to delete");
    }

    if (target.writable !== 1) {
        // Roots are read-only by default and genuinely immutable (§18.1). This is the last
        // check before the only write the app ever makes inside a media root.
        throw new ReadOnlyRootError("This item is in a read-only root and cannot be deleted");
    }

    if (target.state === "trashed") {
        throw new ConflictError("This item is already in the trash");
    }

    /**
     * Whether an identical file stays (§10e). If one does, this copy bypasses the bin: the trash
     * job deletes it outright and purges the item.
     */
    const hasTwin = trashRepo.findIdenticalActiveFile(target.fileId, null) !== null;

    /**
     * Before anything is trashed, so a failure here leaves the library untouched rather than
     * an item deleted with its record stranded on it. The other order fails the wrong way:
     * merging again later is harmless -- every rule is idempotent -- while deleting without
     * merging is the data loss this exists to prevent.
     */
    const merged = await whenNotBusy(() => mergeIntoSurvivingCopy(mediaId));

    // The heir's file when it is one of the identical ones: everything recorded about the item
    // went there, and when a whole group goes best-last it is the copy whose bytes stay in the
    // bin, so the content survives there (§10d).
    const twinFileId = hasTwin
        ? trashRepo.findIdenticalActiveFile(target.fileId, merged?.heirId ?? null)
        : null;

    const retentionDays = loadTrashSettings().retentionDays;

    // The entry and an identical copy's delete job in one lock: both or neither, so a retry can
    // never write a second entry for a first that landed without its job.
    const entry = await whenNotBusy(() =>
        db
            .transaction(() => {
                const created = trashRepo.create({
                    mediaId,
                    fileId: target.fileId,
                    rootId: target.rootId,
                    relPath: target.relPath,
                    bytes: target.size,
                    deletedById: auth.userId,
                    retentionDays,
                    twinFileId,
                });

                if (twinFileId) {
                    trashRepo.enqueueMove("trash", created.id, mediaId, target.fileId);
                }

                // In the same transaction (§13b): it is what tells another tab, or another
                // person, that this tile has left the library -- their grid drops it.
                changeLogRepo.record({
                    entity: "media",
                    entityId: mediaId,
                    rootId: target.rootId,
                    op: "delete",
                    detail: "trash",
                });

                return created;
            })
            .immediate()
    );

    // The item left every count the moment its entry was written, and the person who trashed
    // it is looking at the number that should go down (§20).
    clearLibraryCaches();

    return { entryId: entry.id, merged };
};

/**
 * An entry in the bin of the request's room (§21). Another room's reads as not found, as the
 * bin's own list never shows it.
 */
const entryInRoom = (entryId: string, auth: AuthContext): trashRepo.TrashEntryRow | undefined => {
    const entry = trashRepo.findById(entryId);

    return entry && auth.accessibleRootIds.includes(entry.rootId) ? entry : undefined;
};

/**
 * Brings an item back.
 *
 * Through a job, like the purge, because entries from before 2026-11-13 have their bytes in
 * `dataDir/trash` and the catalogue must wait for them to be copied back: showing an item
 * before its file is there would put a tile in the grid that cannot play. For every other
 * entry the job is the catalogue alone, and lands in moments.
 */
export const restoreEntry = (entryId: string, auth: AuthContext): void => {
    requireAdmin(auth, "restore a deleted item");

    const entry = entryInRoom(entryId, auth);

    // An identical copy's entry is not the bin's (§10e): it is deleted outright, and there is
    // nothing to restore it from but the copy that stayed.
    if (!entry || entry.restoredAt || entry.purgedAt || entry.twinFileId) {
        throw new NotFoundError("Trash entry not found");
    }

    trashRepo.enqueueMove("restore", entry.id, entry.mediaId, entry.fileId);
};

/**
 * Destroys an item ahead of its window.
 *
 * Separate from the sweep only in what triggers it. Both go through the same repo call, so
 * "an admin purged it" and "the window closed" cannot diverge in what they actually do.
 */
export const purgeEntry = (entryId: string, auth: AuthContext): void => {
    requireAdmin(auth, "purge a deleted item");

    const entry = entryInRoom(entryId, auth);

    // Its own trash job purges an identical copy's entry (§10e).
    if (!entry || entry.restoredAt || entry.purgedAt || entry.twinFileId) {
        throw new NotFoundError("Trash entry not found");
    }

    trashRepo.enqueueMove("purge", entry.id, entry.mediaId, entry.fileId);
};

/**
 * Empties the bin now, instead of waiting for each entry's window (§10).
 *
 * Every entry goes through the same purge job as the sweep and the per-entry button, so this
 * cannot do anything a purge would not.
 */
export const emptyTrash = (auth: AuthContext): EmptyTrashResponse => {
    requireAdmin(auth, "empty the trash");

    let queued = 0;
    let freedBytes = 0;

    for (const entry of trashRepo.listOpen(auth.accessibleRootIds)) {
        trashRepo.enqueueMove("purge", entry.id, entry.mediaId, entry.fileId);
        queued += 1;

        freedBytes += entry.bytes;
    }

    return { queued, freedBytes };
};

export const listTrash = (auth: AuthContext, limit: number, offset: number): TrashListResponse => {
    requireAdmin(auth, "view the trash");

    const entries: TrashEntry[] = trashRepo
        .listPending(auth.accessibleRootIds, limit, offset)
        .map((row) => ({
            id: row.id,
            mediaId: row.mediaId,
            title: row.title,
            kind: row.kind,
            rootLabel: row.rootLabel,
            relPath: row.relPath,
            bytes: row.bytes,
            deletedBy: row.deletedBy,
            deletedAt: row.deletedAt,
            purgeAfter: row.purgeAfter,
            // Served from the item's own art route, which still resolves: the artifact rows live
            // until purge precisely so the bin can be looked at rather than guessed at.
            coverUrl: row.mediaId
                ? coverUrl(row.mediaId, row.coverPath, row.coverGeneratedAt)
                : null,
        }));

    return {
        entries,
        total: trashRepo.countPending(auth.accessibleRootIds),
        heldBytes: trashRepo.heldBytes(auth.accessibleRootIds),
    };
};
