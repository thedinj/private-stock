import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { resolveFfmpeg } from "./binaries.js";
import { capThreads } from "./ffmpegThreads.js";
// Polite like every other background spawn (§7c). This file used a bare `execFile`, so six VP9
// encodes per preview ran at full priority beside the web process.
import { execFilePolitely as execFileAsync } from "./politeSpawn.js";

/**
 * Building the hover preview: short clips sampled across a video, joined into one file (§9).
 *
 * Encoded per segment and concatenated, rather than trimmed out of the source in a single
 * filtergraph. A `trim`/`concat` graph looks tidier but makes ffmpeg decode the entire file
 * to reach the last segment, which for a two-hour video is minutes of CPU to produce six
 * seconds of output. Six fast seeks cost almost nothing by comparison.
 */

const SEGMENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Segments sampled across the video, and how long each runs. */
export const PREVIEW_SEGMENTS = 6;
export const PREVIEW_SEGMENT_MS = 1_000;

/**
 * Preview height. 480p is the §9 figure and is generous for something shown in a grid tile,
 * but the same file is also what gallery mode plays, where it can be most of the screen.
 */
const PREVIEW_HEIGHT = 480;

/** Frame rate. Low enough to keep the file small, high enough to read as motion. */
const PREVIEW_FPS = 15;

/**
 * Where the segments are taken from, as fractions of the duration.
 *
 * Spread across the whole video rather than bunched at the front: the preview's job is to
 * answer "what is this?", and six seconds from the opening titles answers nothing. The last
 * is at 85% rather than the end, which is usually credits.
 */
const SEGMENT_FRACTIONS = [0.05, 0.2, 0.35, 0.5, 0.68, 0.85];

export const previewOffsets = (durationMs: number | null): number[] => {
    if (!durationMs || durationMs <= 0) {
        return [];
    }

    // Leave room for a whole segment after the last offset, so no segment is cut short by
    // the end of the file.
    const usable = Math.max(0, durationMs - PREVIEW_SEGMENT_MS);

    if (usable <= 0) {
        return [0];
    }

    const offsets = SEGMENT_FRACTIONS.slice(0, PREVIEW_SEGMENTS).map((fraction) =>
        Math.floor(usable * fraction)
    );

    // A very short clip maps several fractions onto the same second; one segment of it is
    // the honest preview rather than the same second repeated six times.
    return [...new Set(offsets)];
};

/**
 * Encode the segments and join them into one silent WebM at `outputPath`.
 *
 * Returns false when nothing usable could be produced, which is a fact about the file rather
 * than a failure to retry — a two-second clip has no six samples to take.
 */
export const renderPreview = async (
    inputPath: string,
    outputPath: string,
    durationMs: number | null
): Promise<boolean> => {
    const ffmpeg = await resolveFfmpeg();
    const offsets = previewOffsets(durationMs);

    if (offsets.length === 0) {
        return false;
    }

    /**
     * A directory of this attempt's own, and the `mkdtemp` suffix is the whole of the fix.
     *
     * It was `.preview-parts`, named from the item alone — so two attempts at the same item shared
     * it. That is not hypothetical: a claim goes stale after `STALE_CLAIM_MS` of silence, the
     * heartbeat behind it is a timer on an event loop that this app has had blocked for
     * *seconds* at a time (§20), and a VP9 encode of six segments on a throttled NAS runs for
     * minutes. So a job still running was handed to a second attempt, and both wrote `part-0.webm`
     * in the same place. ffmpeg reported it exactly as two writers in one file look —
     *
     *     [matroska,webm] Duplicate element
     *     [matroska,webm] Element at 0x5d ... exceeds containing master element ending at 0x1409
     *     [concat] Impossible to open '.../.preview-parts/part-0.webm'
     *
     * — the last line because the attempt that finished first had already run the `rm` below,
     * deleting the parts out from under the one still concatenating.
     *
     * Two attempts can still overlap; this makes that merely wasteful instead of corrupting, which
     * is the right division of labour. Whether a job can be claimed twice is a question about the
     * queue, and a pipeline that writes to a fixed path should not be relying on the answer.
     */
    const workDir = await mkdtemp(path.join(path.dirname(outputPath), ".preview-parts-"));

    try {
        const parts: string[] = [];

        for (const [index, atMs] of offsets.entries()) {
            const partPath = path.join(workDir, `part-${index}.webm`);

            try {
                await encodeSegment(ffmpeg, inputPath, partPath, atMs);

                /**
                 * Trust the file, not the exit code.
                 *
                 * `concat -c copy` reads every byte of every part, so one unreadable part fails
                 * the whole preview — and the comment below has always claimed that one bad region
                 * costs only itself. That was only true of segments whose *encode* failed. A part
                 * that was written and is not readable is the same kind of loss and now gets the
                 * same treatment.
                 */
                if (await isReadableVideo(partPath)) {
                    parts.push(partPath);
                }
            } catch {
                // One unreadable region must not cost the other five.
            }
        }

        if (parts.length === 0) {
            return false;
        }

        await concatenate(ffmpeg, parts, workDir, outputPath);

        return true;
    } finally {
        // Whatever happened, this attempt's parts directory does not survive: it sits inside the
        // artifact directory the web app serves from. Only ours, now that the name is unique —
        // a concurrent attempt's work is none of our business.
        await rm(workDir, { recursive: true, force: true });
    }
};

/**
 * Whether ffmpeg will be able to read this part back.
 *
 * One `ffprobe` per segment, against six VP9 encodes — unmeasurable next to the work it guards.
 * It asks for the stream's frame count rather than merely opening the file, because the failure
 * being caught is a container whose header parses and whose contents do not.
 */
const isReadableVideo = async (partPath: string): Promise<boolean> => {
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
                "-count_packets",
                "-show_entries",
                "stream=nb_read_packets",
                "-of",
                "csv=p=0",
                partPath,
            ],
            { timeout: SEGMENT_TIMEOUT_MS }
        );

        return Number(stdout.trim()) > 0;
    } catch {
        return false;
    }
};

const encodeSegment = async (
    ffmpeg: string,
    inputPath: string,
    outputPath: string,
    atMs: number
): Promise<void> => {
    await execFileAsync(
        ffmpeg,
        capThreads([
            "-v",
            "error",
            "-y",
            // Before `-i`: seek by container index rather than decoding from the start.
            "-ss",
            (atMs / 1000).toFixed(3),
            "-t",
            (PREVIEW_SEGMENT_MS / 1000).toFixed(3),
            "-i",
            inputPath,
            // Silent by design. A grid of tiles that all start talking at once is the reason
            // autoplay policies exist, and muted video is what browsers allow to autoplay.
            "-an",
            "-sn",
            "-vf",
            `fps=${PREVIEW_FPS},scale=-2:'min(${PREVIEW_HEIGHT},ih)':flags=lanczos`,
            "-c:v",
            "libvpx-vp9",
            // `realtime` with a high cpu-used is the difference between a second per segment
            // and a minute. The output is a six-second thumbnail loop; nobody is studying its
            // compression efficiency.
            "-deadline",
            "realtime",
            "-cpu-used",
            "5",
            "-b:v",
            "400k",
            "-pix_fmt",
            "yuv420p",
            outputPath,
        ]),
        { timeout: SEGMENT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
};

/**
 * Join the parts with the concat demuxer, copying rather than re-encoding.
 *
 * Every part came out of the same encoder with the same settings, so the streams are
 * compatible and a copy is exact and instant. Re-encoding here would halve the quality for
 * no reason.
 */
const concatenate = async (
    ffmpeg: string,
    parts: string[],
    workDir: string,
    outputPath: string
): Promise<void> => {
    const listPath = path.join(workDir, "parts.txt");

    // The concat demuxer's own quoting: single quotes around each path, with any single quote
    // inside escaped. Backslashes are fine unescaped, which matters on Windows.
    const list = parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join("\n");

    await writeFile(listPath, `${list}\n`, "utf8");

    await execFileAsync(
        ffmpeg,
        [
            "-v",
            "error",
            "-y",
            "-f",
            "concat",
            // The list holds absolute paths, which the demuxer refuses without this.
            "-safe",
            "0",
            "-i",
            listPath,
            "-c",
            "copy",
            outputPath,
        ],
        { timeout: SEGMENT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
};
