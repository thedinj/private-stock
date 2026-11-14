import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * The recycle bin's file operations (§10, §18.1).
 *
 * A trashed file stays at its path, so the operation that matters is `removeOriginal`, at
 * purge. The rest serve entries made before 2026-11-13, when trashing copied the bytes into
 * `dataDir/trash` -- `/data` and `/media` are separate mounts, so `rename()` between them fails
 * with `EXDEV` even on one disk. They drain within a retention window, and these go with them.
 */

const manifestPathFor = (absolutePath: string): string => `${absolutePath}.json`;

/**
 * Copies a file and makes the copy durable before returning.
 *
 * The fsync is not decoration. Without it the copy exists only in the page cache, and
 * unlinking the source immediately afterwards means a power cut between the two loses the
 * file entirely — the one outcome a recycle bin exists to prevent.
 */
const copyDurable = async (from: string, to: string): Promise<void> => {
    await mkdir(path.dirname(to), { recursive: true });

    await pipeline(createReadStream(from), createWriteStream(to));

    const handle = await open(to, "r+");

    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
};

/**
 * Removes an original from its media root -- the only write this app ever makes inside one
 * (§18.1).
 *
 * At purge, once the retention window has closed, and straight away for a file with an
 * identical twin that stays (§10e): its content survives in the twin, so it bypasses the bin.
 */
export const removeOriginal = async (sourcePath: string): Promise<void> => {
    await unlink(sourcePath).catch((error: NodeJS.ErrnoException) => {
        // Already gone is success: someone deleted it by hand, or a previous attempt got this
        // far before dying. Failing here would leave a bin entry nothing can resolve.
        if (error.code !== "ENOENT") {
            throw error;
        }
    });
};

/**
 * Put a file moved into `dataDir/trash` back where it came from.
 *
 * **Refuses to overwrite.** The old path can be occupied by something entirely different by
 * now, and a restore that silently replaces it destroys a file nobody asked to delete —
 * turning an undo into the very thing it is meant to undo. The caller reports the clash and
 * leaves both files intact.
 */
export const restoreFromTrash = async (trashPath: string, sourcePath: string): Promise<void> => {
    if ((await sizeOf(sourcePath)) !== null) {
        throw new Error(`Something already exists at ${sourcePath}`);
    }

    await copyDurable(trashPath, sourcePath);

    await unlink(trashPath).catch(() => undefined);
    await unlink(manifestPathFor(trashPath)).catch(() => undefined);
};

/** Removes bytes moved into `dataDir/trash`, for good, once the retention window has closed. */
export const purgeFromTrash = async (trashPath: string): Promise<void> => {
    await unlink(trashPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
            throw error;
        }
    });

    await unlink(manifestPathFor(trashPath)).catch(() => undefined);
};

/** Null when the path does not exist, so callers can branch without a second stat. */
export const sizeOf = async (target: string): Promise<number | null> => {
    try {
        return (await stat(target)).size;
    } catch {
        return null;
    }
};
