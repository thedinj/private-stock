import { stat, unlink } from "node:fs/promises";
import * as path from "node:path";

import { assertSafeRelativePath } from "@private-stock/core";
import { dataPaths, libraryFilePath, loadConfig } from "@private-stock/core/server";
import { artifactRepo, mediaFileRepo, mediaRootRepo, trashRepo } from "@private-stock/db";

import { purgeFromTrash, removeOriginal, restoreFromTrash, sizeOf } from "../media/trashMove.js";
import type { JobRow } from "../queue.js";
import { expectRemoval } from "../scan/watcher.js";

/**
 * The jobs that act on the recycle bin's files (§10, §18.1).
 *
 * A trashed file stays at its path until it is purged, so trashing and restoring touch no
 * bytes. What is left for a job is the deletion itself -- the one write the app makes inside a
 * media root, which belongs on the process that owns file operations, not the one serving
 * pages -- and the entries made before 2026-11-13, whose bytes were copied into
 * `dataDir/trash` and are restored and purged from there until the last of them drains.
 */

/** Where an entry's bytes are, resolved once so no caller builds a path by hand. */
interface Endpoints {
    /** The original, inside a media root. */
    sourcePath: string;
    /** In `dataDir/trash`, for an entry whose bytes were moved there. Null otherwise. */
    trashPath: string | null;
}

/**
 * Resolves an entry to absolute paths.
 *
 * `assertSafeRelativePath` runs on both values as they come *out* of the database, not only
 * when they go in. A path that became unsafe through a bug is exactly as dangerous as one
 * that arrived that way, and one of these two paths is inside a media root.
 */
const endpointsFor = (entry: trashRepo.TrashEntryRow): Endpoints => {
    const config = loadConfig();
    const root = mediaRootRepo.findById(entry.rootId);

    if (!root) {
        throw new Error(`Root ${entry.rootId} no longer exists`);
    }

    return {
        sourcePath: libraryFilePath(root.path, entry.relPath),
        trashPath:
            entry.movedAt && entry.trashRelPath
                ? path.resolve(dataPaths(config).trash, assertSafeRelativePath(entry.trashRelPath))
                : null,
    };
};

/**
 * Refuses to destroy a file that is not the one the catalogue describes.
 *
 * Paths are resolved against the library's *current* directory, so a repointed library, or a
 * catalogue that has simply drifted, can point a deletion at a different file that happens to
 * occupy the same relative path. Without this, the app would delete something nobody had ever
 * seen and record it under the name of something else.
 *
 * Size and mtime are what the scanner itself treats as identity (§7) — the same bet every
 * backup tool makes — so agreeing with it here costs one stat and no new concepts. Refusing
 * is always safe: the file stays, the item stays, and a rescan makes the deletion possible
 * again.
 */
const assertFileIsTheOneCatalogued = async (
    fileId: string | null,
    sourcePath: string
): Promise<void> => {
    if (!fileId) {
        return;
    }

    const file = mediaFileRepo.findById(fileId);

    if (!file) {
        return;
    }

    let stats;
    try {
        stats = await stat(sourcePath);
    } catch {
        // Already gone. Nothing to destroy, and removing a missing original is success.
        return;
    }

    // Whole seconds, because not every filesystem stores more than that and a rounding
    // difference is not a different file.
    const sameMtime = Math.floor(stats.mtimeMs / 1000) === Math.floor(file.mtime / 1000);

    if (stats.size !== file.size || !sameMtime) {
        throw new Error(
            `Refusing to delete ${entryDescription(file.relPath)}: the file on disk is not the ` +
                "one that was catalogued. Rescan the library and try again."
        );
    }
};

/** Quoted so a path with spaces reads as one thing in the job log. */
const entryDescription = (relPath: string): string => `"${relPath}"`;

/**
 * Whether a file still holds its bytes, provably unchanged, somewhere they will stay (§10e).
 *
 * What deleting an identical copy outright rests on: the same content has to survive
 * elsewhere. An active file holds them at its library path -- if the file there still has the
 * size and mtime the catalogue recorded, which is what keeps its `contentHash` true: the scanner
 * clears the hash when either changes, but only once it has been round, and this is asked in
 * between.
 *
 * A file in the bin with its own bytes holds them too -- at its library path, where a trashed
 * file stays until purge. That is the case of a whole group being deleted best-last (§10d):
 * every copy but the last goes outright, and the last keeps the content in the bin, restorable
 * as usual. A file that was itself deleted outright holds nothing.
 */
const holdsBytes = async (fileId: string): Promise<boolean> => {
    const file = mediaFileRepo.findById(fileId);

    if (!file) {
        return false;
    }

    const root = mediaRootRepo.findById(file.rootId);

    const unchangedInLibrary = async (): Promise<boolean> => {
        if (!root) return false;

        try {
            const stats = await stat(libraryFilePath(root.path, file.relPath));
            const sameMtime = Math.floor(stats.mtimeMs / 1000) === Math.floor(file.mtime / 1000);

            return stats.size === file.size && sameMtime;
        } catch {
            return false;
        }
    };

    if (file.state === "active") {
        return unchangedInLibrary();
    }

    const entry = file.state === "trashed" ? trashRepo.findOpenForFile(fileId) : undefined;

    if (!entry || entry.twinFileId) {
        return false;
    }

    const { trashPath } = endpointsFor(entry);

    if (!trashPath) {
        return unchangedInLibrary();
    }

    // Moved into dataDir/trash before 2026-11-13: the copy was fsynced before the original
    // went, so its size is the check.
    return (await sizeOf(trashPath)) === file.size;
};

/**
 * Deletes an identical copy outright (§10e) -- the only kind of entry that has a trash job.
 *
 * An ordinary entry needs none: its file stays where it is until the purge. One with a twin
 * bypasses the bin instead: the original is deleted and the item purged in the same job, so it
 * never appears in the trash and there is nothing to restore -- the content is the twin's.
 *
 * Only once the twin provably still holds the bytes: present, and unchanged since it was
 * hashed, which the check below says of this file too, so equal hashes still mean equal bytes.
 * When the twin cannot vouch, deleting outright could lose the content, so the entry becomes an
 * ordinary one and its file stays in place like any other in the bin.
 *
 * Retried freely: every step is idempotent, and the entry it works from does not change
 * underneath it.
 */
export const runTrash = async (job: JobRow): Promise<void> => {
    const entry = trashRepo.findForJob(job.payloadJson);

    if (!entry || entry.restoredAt || entry.purgedAt || !entry.twinFileId) {
        // Restored or purged while this sat in the queue, or an ordinary entry -- one queued
        // before trashing stopped moving bytes. Nothing to do for any of them.
        return;
    }

    const { sourcePath } = endpointsFor(entry);

    await assertFileIsTheOneCatalogued(entry.fileId, sourcePath);

    if (!(await holdsBytes(entry.twinFileId))) {
        trashRepo.clearTwin(entry.id);

        return;
    }

    await removeOriginal(sourcePath);

    // Recorded in the catalogue below: the watcher need not walk the directory to learn it.
    expectRemoval(sourcePath);

    if (entry.mediaId) {
        await removeArtifacts(entry.mediaId);
    }

    // Takes the item, its file row and every job it still has (`trashRepo.purge`).
    trashRepo.purge(entry.id);
};

/**
 * Returns the item to the library.
 *
 * Its file never left its path, so this is the catalogue alone. An entry whose bytes were
 * moved into `dataDir/trash` copies them back first, and only then returns the item, so a
 * failed copy leaves it in the bin where someone can try again -- rather than in the grid,
 * pointing at a file that is not there.
 *
 * A file that changed or vanished while in the bin comes back as whatever the next scan finds:
 * changed bytes are reprocessed, a missing file is marked missing. Neither is worth refusing a
 * restore over.
 */
export const runRestore = async (job: JobRow): Promise<void> => {
    const entry = trashRepo.findForJob(job.payloadJson);

    if (!entry || entry.restoredAt || entry.purgedAt) {
        return;
    }

    const { sourcePath, trashPath } = endpointsFor(entry);

    if (trashPath) {
        await restoreFromTrash(trashPath, sourcePath);
    }

    trashRepo.markRestored(entry.id);
};

/**
 * The irreversible one: unlinks the file at its path, then purges the item.
 *
 * Refuses to act if the file is no longer trashed. That happens when someone replaces the file
 * by hand and a scan revives the row, and the consequence of not checking is destroying an
 * item the library is actively showing — the single outcome this feature must never produce.
 * The scan path resolves such entries itself; this is the second lock on the same door,
 * because it is the only step that cannot be undone. The third is the identity check: the
 * bytes at the path must still be the ones that were trashed.
 */
export const runPurge = async (job: JobRow): Promise<void> => {
    const entry = trashRepo.findForJob(job.payloadJson);

    if (!entry || entry.restoredAt || entry.purgedAt) {
        return;
    }

    if (entry.fileId) {
        const file = trashRepo.fileStateOf(entry.fileId);

        if (file !== "trashed") {
            throw new Error(
                `Refusing to purge ${entry.relPath}: its file is "${file ?? "gone"}", not trashed`
            );
        }
    }

    const { sourcePath, trashPath } = endpointsFor(entry);

    if (!trashPath) {
        await assertFileIsTheOneCatalogued(entry.fileId, sourcePath);
    }

    // Artifacts first: the rows are about to cascade away with the item, and an artifact file
    // whose row is gone is invisible to every cleanup the app has.
    if (entry.mediaId) {
        await removeArtifacts(entry.mediaId);
    }

    if (trashPath) {
        await purgeFromTrash(trashPath);
    } else {
        await removeOriginal(sourcePath);

        // Recorded in the catalogue below: the watcher need not walk the directory to learn it.
        expectRemoval(sourcePath);
    }

    trashRepo.purge(entry.id);
};

/**
 * Covers, previews, sprite sheets and captures, removed from disk before their rows disappear.
 *
 * `relPath` already names its tree (`art/…` or `captures/…`), so it resolves against
 * `dataDir`. It used to resolve against `art`, which unlinked `art/art/…`: the swallowed
 * error hid the miss, and every purge leaked the item's files until the orphan sweep. The
 * whitelist is the same one the art route uses, so a bad row cannot reach anything else.
 */
const removeArtifacts = async (mediaId: string): Promise<void> => {
    const config = loadConfig();
    const paths = dataPaths(config);
    const roots = [paths.art, paths.captures].map((root) =>
        root.endsWith(path.sep) ? root : root + path.sep
    );

    for (const artifact of artifactRepo.listForMedia(mediaId)) {
        const absolute = path.resolve(config.dataDir, assertSafeRelativePath(artifact.relPath));

        if (!roots.some((root) => absolute.startsWith(root))) {
            continue;
        }

        await unlink(absolute).catch(() => undefined);
    }
};
