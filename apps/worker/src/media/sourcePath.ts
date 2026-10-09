import { NotFoundError } from "@private-stock/core";
import { libraryFilePath } from "@private-stock/core/server";
import { mediaFileRepo, mediaRootRepo } from "@private-stock/db";

/**
 * Resolve a stored file id to an absolute path on disk.
 *
 * Shared by every job that opens an original. `assertSafeRelativePath` runs on the value
 * coming *out* of the database, not only on input: a path that became unsafe through a bug
 * is exactly as dangerous as one that arrived that way, and a media root holds files the app
 * is never allowed to write to (§18.1).
 */

export interface ResolvedSource {
    absolutePath: string;
    rootId: string;
    relPath: string;
}

/** Returns null when the file has gone — the caller decides whether that is an error. */
export const resolveSource = (fileId: string): ResolvedSource | null => {
    const file = mediaFileRepo.findById(fileId);

    if (!file) {
        return null;
    }

    const root = mediaRootRepo.findById(file.rootId);

    if (!root) {
        throw new NotFoundError(`Root ${file.rootId} no longer exists`);
    }

    return {
        absolutePath: libraryFilePath(root.path, file.relPath),
        rootId: file.rootId,
        relPath: file.relPath,
    };
};
