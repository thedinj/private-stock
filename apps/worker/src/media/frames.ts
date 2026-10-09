import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import {
    FRAME_TIMEOUT_MS,
    frameArgs,
    resolveFfmpeg,
    type ExtractFrameOptions,
} from "@private-stock/core/server";

// Aliased so the call sites read unchanged: the only difference from a bare
// `execFile` is that background work lowers its child's priority (§7c).
import { capThreads } from "./ffmpegThreads.js";
import { execFilePolitely as execFileAsync } from "./politeSpawn.js";

/**
 * Pulling still frames out of media with ffmpeg.
 *
 * Shared rather than living in the cover job, because sprite sheets and hover previews are
 * the same operation with different framing — and because the two decisions worth getting
 * right (how to seek, and how to avoid a black frame) should have exactly one implementation.
 *
 * `execFile`, never `exec`: arguments go to the process directly rather than through a
 * shell, so a filename containing a quote, a semicolon, or a backtick is just a filename.
 * Media libraries are full of such names.
 */

/**
 * Write a single frame of `inputPath` to `outputPath` as WebP.
 *
 * The arguments come from `@private-stock/core/server`, which the web app also uses for a
 * user's capture (§13). What stays here is the spawn: background work lowers its child's
 * priority, and a frame someone is waiting for does not (§7c).
 */
export const extractFrame = async (
    inputPath: string,
    outputPath: string,
    options: ExtractFrameOptions
): Promise<void> => {
    const ffmpeg = await resolveFfmpeg();

    await mkdir(path.dirname(outputPath), { recursive: true });

    await execFileAsync(ffmpeg, capThreads(frameArgs(inputPath, outputPath, options)), {
        timeout: FRAME_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
    });
};

/**
 * Average luminance of an image, 0-255.
 *
 * Reads the generated file back rather than analysing the source, which keeps it a plain
 * argument to ffmpeg. The alternative — the `signalstats` filter over a `movie=` source —
 * needs the input path escaped *inside* a filter string, where a Windows drive letter's colon
 * and every backslash are filter syntax. That is a parsing problem with no good answer, and
 * decoding one 640px WebP costs nothing by comparison.
 *
 * Downscaling to 16x16 first means ffmpeg averages the pixels and we average 256 bytes.
 */
export const averageLuminance = async (imagePath: string): Promise<number> => {
    const ffmpeg = await resolveFfmpeg();

    const { stdout } = await execFileAsync(
        ffmpeg,
        capThreads([
            "-v",
            "error",
            "-i",
            imagePath,
            "-vf",
            "scale=16:16,format=gray",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "pipe:1",
        ]),
        {
            timeout: FRAME_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
            // Binary on stdout: a string conversion would mangle every byte above 0x7f.
            encoding: "buffer",
        }
    );

    const pixels = stdout as unknown as Buffer;

    if (pixels.length === 0) {
        return 0;
    }

    let total = 0;
    for (const value of pixels) {
        total += value;
    }

    return total / pixels.length;
};

/**
 * Below this average luminance a frame is a black screen, a fade, or a dark title card.
 *
 * Deliberately low. The failure to avoid is rejecting legitimately dark cinematography and
 * ending up with a cover from the middle of the credits instead; a genuinely black frame
 * measures close to zero, so there is a wide margin between the two cases.
 */
export const NEAR_BLACK_LUMINANCE = 18;

/** Pixel dimensions of an image file, read with ffprobe. */
export const imageDimensions = async (
    imagePath: string
): Promise<{ width: number | null; height: number | null }> => {
    const { resolveFfprobe } = await import("./binaries.js");
    const ffprobe = await resolveFfprobe();

    try {
        const { stdout } = await execFileAsync(
            ffprobe,
            [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
                imagePath,
            ],
            { timeout: FRAME_TIMEOUT_MS, maxBuffer: 64 * 1024 }
        );

        const [width, height] = stdout.trim().split(",").map(Number);

        return {
            width: Number.isFinite(width) ? width : null,
            height: Number.isFinite(height) ? height : null,
        };
    } catch {
        // Dimensions are metadata for the UI, not correctness. A cover that exists with
        // unknown dimensions beats a failed job that retries three times and leaves none.
        return { width: null, height: null };
    }
};
