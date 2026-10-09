import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { resolveFfmpeg } from "@private-stock/core/server";

/**
 * Reading pictures in and writing vectors out, for every model the child runs (§5e, §5f).
 */

const execFileAsync = promisify(execFile);

/** A sheet is a few MB decoded; this is far beyond any that exists, and below a runaway. */
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

const DECODE_TIMEOUT_MS = 2 * 60 * 1000;

/** A picture as raw RGB at the size its row records; anything else is a mismatch, not a guess. */
export const decodePicture = async (source: {
    absolutePath: string;
    width: number;
    height: number;
}): Promise<Uint8Array> => {
    const ffmpeg = await resolveFfmpeg();
    const { stdout } = await execFileAsync(
        ffmpeg,
        [
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            source.absolutePath,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        { encoding: "buffer", maxBuffer: MAX_DECODED_BYTES, timeout: DECODE_TIMEOUT_MS }
    );

    if (stdout.length !== source.width * source.height * 3) {
        throw new Error(
            `${path.basename(source.absolutePath)} decoded to ${stdout.length} bytes, not ${source.width}x${source.height}`
        );
    }

    return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length);
};

/**
 * Write a file under a temporary name and rename it into place, so a reader never sees half of
 * it and a borrowing twin can hardlink it safely (`placeDataFile`).
 */
export const writeInPlace = async (outPath: string, bytes: Uint8Array): Promise<void> => {
    const partial = `${outPath}.partial`;

    await mkdir(path.dirname(outPath), { recursive: true });

    try {
        await writeFile(partial, bytes);
        await rename(partial, outPath);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
};
