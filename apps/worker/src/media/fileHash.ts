import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

/**
 * File identity hashes (§5).
 *
 * Two hashes with different jobs, and the difference is the whole design:
 *
 * - **quickHash** — size plus the first and last mebibyte. Three seeks regardless of file
 *   size, so it costs the same for a 40 MB clip and a 40 GB remux. It answers "is this the
 *   same file I catalogued last time" on every rescan, and narrows the field for the
 *   question below.
 * - **contentHash** — the whole file. It is the only thing that *proves* two files are
 *   identical, and it is far too expensive to compute for everything: a 4 TB library over
 *   SMB would take days and saturate the share the app is meant to be serving from.
 *
 * So contentHash is computed lazily, only where a quickHash collision says it might matter.
 * That ordering is what makes exact-duplicate detection affordable at all.
 */

/** Bytes read from each end for the quick hash. Matches §5's "first 1 MiB and last 1 MiB". */
const QUICK_WINDOW = 1024 * 1024;

/**
 * sha1, not sha256.
 *
 * This is a content *identifier*, not a security boundary: nothing is authenticated by it and
 * an attacker who could write files into the media root already has everything worth having.
 * sha1 is roughly twice as fast, and on a NAS hashing terabytes over a network share, that
 * difference is hours.
 */
const ALGORITHM = "sha1";

/**
 * Size plus both ends of the file.
 *
 * Size is mixed in first, so two files that happen to share their first and last mebibyte —
 * which is exactly what a truncated download and its complete original do — do not collide.
 * Without it, an interrupted copy would look like the file it was copied from.
 */
export const quickHashFile = async (absolutePath: string): Promise<string | null> => {
    try {
        const info = await stat(absolutePath);
        const hash = createHash(ALGORITHM);

        hash.update(`${info.size}:`);

        const handle = await open(absolutePath, "r");

        try {
            const window = Math.min(QUICK_WINDOW, info.size);
            const head = Buffer.allocUnsafe(window);

            await handle.read(head, 0, window, 0);
            hash.update(head);

            // Only when the file is big enough for the two windows to be different bytes;
            // otherwise the head is the whole file and reading it twice adds nothing.
            if (info.size > QUICK_WINDOW) {
                const tailSize = Math.min(QUICK_WINDOW, info.size - QUICK_WINDOW);
                const tail = Buffer.allocUnsafe(tailSize);

                await handle.read(tail, 0, tailSize, info.size - tailSize);
                hash.update(tail);
            }

            return hash.digest("hex");
        } finally {
            await handle.close();
        }
    } catch {
        // A file that vanished or is unreadable is not a failed job — the next scan will
        // mark it missing. Returning null lets the caller move on.
        return null;
    }
};

/**
 * The whole file, streamed.
 *
 * Streamed rather than read into memory for the obvious reason: these files run to tens of
 * gigabytes and the NAS has single-digit gigabytes of RAM, most of which ffmpeg wants.
 */
export const contentHashFile = async (absolutePath: string): Promise<string | null> =>
    new Promise((resolve) => {
        const hash = createHash(ALGORITHM);
        const stream = createReadStream(absolutePath, { highWaterMark: 4 * 1024 * 1024 });

        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", () => resolve(null));
    });
