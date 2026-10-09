import { stat, unlink } from "node:fs/promises";
import * as path from "node:path";

import { assertSafeRelativePath } from "@private-stock/core";
import { dataPaths, libraryFilePath, loadConfig } from "@private-stock/core/server";
import { artifactRepo, mediaFileRepo, mediaRootRepo, trashRepo } from "@private-stock/db";

import {
    moveToTrash,
    purgeFromTrash,
    removeOriginal,
    restoreFromTrash,
    sizeOf,
} from "../media/trashMove.js";
import type { JobRow } from "../queue.js";
import { expectRemoval } from "../scan/watcher.js";

/**
 * The three jobs that move bytes in and out of the recycle bin (§10, §18.1).
 *
 * They are jobs rather than request handlers because a 10 GB file takes minutes to copy
 * across volumes, and because this is the one place the app writes inside a media root — work
 * that belongs on the process that already owns long file operations, not on the one serving
 * pages.
 */

/** Both ends of a move, resolved once so no caller builds a path by hand. */
interface Endpoints {
    sourcePath: string;
    trashPath: string;
    libraryPath: string;
}

/**
 * Resolves an entry to absolute paths.
 *
 * `assertSafeRelativePath` runs on both values as they come *out* of the database, not only
 * when they go in. A path that became unsafe through a bug is exactly as dangerous as one
 * that arrived that way, and one of these two paths is inside a media root.
 */
const endpointsFor = (rootId: string, relPath: string, trashRelPath: string): Endpoints => {
    const config = loadConfig();
    const root = mediaRootRepo.findById(rootId);

    if (!root) {
        throw new Error(`Root ${rootId} no longer exists`);
    }

    return {
        sourcePath: libraryFilePath(root.path, relPath),
        trashPath: path.resolve(dataPaths(config).trash, assertSafeRelativePath(trashRelPath)),
        libraryPath: root.path,
    };
};

/**
 * Refuses to destroy a file that is not the one the catalogue describes.
 *
 * Paths are resolved against the library's *current* directory, so a repointed library, or a
 * catalogue that has simply drifted, can point a deletion at a different file that happens to
 * occupy the same relative path. Without this, the app would trash something nobody had ever
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
        // Already gone. Nothing to destroy, and the move handles a missing original.
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
 * A file in the bin with its own bytes holds them too -- at its library path until its move
 * lands, then in the bin. That is the case of a whole group being deleted best-last (§10d):
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

    if (!entry.movedAt) {
        return unchangedInLibrary();
    }

    // In the bin: the copy was fsynced before the original went, so its size is the check.
    const { trashPath } = endpointsFor(entry.rootId, entry.relPath, entry.trashRelPath);

    return (await sizeOf(trashPath)) === file.size;
};

/**
 * Copies the original into the bin and removes it from the media root.
 *
 * The catalog side already happened — the item was hidden the moment the request was
 * accepted. This job is only the bytes, which is why it can be retried freely: every step is
 * idempotent, and the entry it works from does not change underneath it.
 */
export const runTrash = async (job: JobRow): Promise<void> => {
    const entry = trashRepo.findForJob(job.payloadJson);

    if (!entry || entry.restoredAt || entry.purgedAt) {
        // Restored or purged while this sat in the queue. Doing nothing is correct: whatever
        // closed the entry has already put the bytes where they belong.
        return;
    }

    const { sourcePath, trashPath, libraryPath } = endpointsFor(
        entry.rootId,
        entry.relPath,
        entry.trashRelPath
    );

    await assertFileIsTheOneCatalogued(entry.fileId, sourcePath);

    /**
     * An identical copy stays (§10e): this one bypasses the bin. The original is deleted and the
     * item purged in the same job, so it never appears in the trash and there is nothing to
     * restore -- the content is the twin's.
     *
     * Only once the twin provably still holds the bytes: present, and unchanged since it was
     * hashed. The check above has just said the same of this file, so equal hashes still mean
     * equal bytes. When the twin cannot vouch, deleting outright could lose the content, so the
     * entry becomes an ordinary one and the move below copies it into the bin.
     */
    if (entry.twinFileId) {
        if (await holdsBytes(entry.twinFileId)) {
            await removeOriginal(sourcePath);
            expectRemoval(sourcePath);

            if (entry.mediaId) {
                await removeArtifacts(entry.mediaId);
            }

            // Takes the item, its file row and every job it still has (`trashRepo.purge`).
            trashRepo.purge(entry.id);

            return;
        }

        trashRepo.clearTwin(entry.id);
    }

    await moveToTrash({
        sourcePath,
        trashPath,
        manifest: {
            entryId: entry.id,
            libraryPath,
            relPath: entry.relPath,
            bytes: entry.bytes,
            deletedAt: entry.deletedAt,
        },
    });

    // Recorded in the catalogue already: the watcher need not walk the directory to learn it.
    expectRemoval(sourcePath);
    trashRepo.markMoved(entry.id);
};

/**
 * Puts the file back, then returns the item to the library.
 *
 * In that order, deliberately. The catalog is updated only once the bytes are in place, so a
 * failed copy leaves the item in the bin where someone can try again — rather than in the
 * grid, pointing at a file that is not there.
 */
export const runRestore = async (job: JobRow): Promise<void> => {
    const entry = trashRepo.findForJob(job.payloadJson);

    if (!entry || entry.restoredAt || entry.purgedAt) {
        return;
    }

    const { sourcePath, trashPath } = endpointsFor(entry.rootId, entry.relPath, entry.trashRelPath);

    await restoreFromTrash(trashPath, sourcePath);

    trashRepo.markRestored(entry.id);
};

/**
 * The irreversible one.
 *
 * Refuses to act if the file is no longer trashed. That happens when someone puts the file
 * back by hand and a scan revives the row, and the consequence of not checking is destroying
 * an item the library is actively showing — the single outcome this feature must never
 * produce. The scan path resolves such entries itself; this is the second lock on the same
 * door, because it is the only step that cannot be undone.
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

    const { trashPath } = endpointsFor(entry.rootId, entry.relPath, entry.trashRelPath);

    // Artifacts first: the rows are about to cascade away with the item, and an artifact file
    // whose row is gone is invisible to every cleanup the app has.
    if (entry.mediaId) {
        await removeArtifacts(entry.mediaId);
    }

    await purgeFromTrash(trashPath);

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
