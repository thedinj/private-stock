import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Moving bytes in and out of the recycle bin (§10, §18.1).
 *
 * `/data` and `/media` are different volumes, so `rename()` between them fails with `EXDEV`.
 * Trashing is therefore copy, fsync, unlink — in that order, and the order is the whole
 * safety argument: the original is not removed until its copy is durable on the other
 * volume. A crash anywhere in the middle leaves the file in both places, which the next
 * attempt resolves. The opposite order loses the file to a power cut.
 */

/** Written beside the bytes so the bin is recoverable without the database (§10). */
export interface TrashManifest {
    entryId: string;
    libraryPath: string;
    relPath: string;
    bytes: number;
    deletedAt: string;
}

const manifestPathFor = (absolutePath: string): string => `${absolutePath}.json`;

/**
 * Copies a file and makes the copy durable before returning.
 *
 * The fsync is not decoration. Without it the copy exists only in the page cache, and
 * unlinking the original immediately afterwards means a power cut between the two loses the
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

export interface MoveToTrashInput {
    /** The original, inside a media root. */
    sourcePath: string;
    /** Where it is going, inside `dataDir/trash`. */
    trashPath: string;
    manifest: TrashManifest;
}

/**
 * Copy into the bin, then remove the original.
 *
 * Idempotent on purpose: a job that is retried after being killed mid-move finds the copy
 * already there and finishes the unlink, rather than failing forever on a half-done move.
 */
export const moveToTrash = async (input: MoveToTrashInput): Promise<void> => {
    const alreadyCopied = await sizeOf(input.trashPath);

    if (alreadyCopied !== input.manifest.bytes) {
        await copyDurable(input.sourcePath, input.trashPath);
    }

    await writeFile(manifestPathFor(input.trashPath), JSON.stringify(input.manifest, null, 2));

    await removeOriginal(input.sourcePath);
};

/**
 * Removes an original from its media root -- the only write this app ever makes inside one
 * (§18.1).
 *
 * Called directly, without a copy, only for a file with an identical twin that stays (§10e):
 * its content survives in the twin, so it bypasses the bin altogether.
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
 * Put a file back where it came from.
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

/** Removes the bytes for good. Called only once the retention window has closed. */
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
