import { PHASH_SIZE } from "@private-stock/core";

import { resolveFfmpeg } from "./binaries.js";
// Aliased so the call sites read unchanged: the only difference from a bare
// `execFile` is that background work lowers its child's priority (§7c).
import { capThreads } from "./ffmpegThreads.js";
import { execFilePolitely as execFileAsync } from "./politeSpawn.js";

/**
 * Decoding to the grayscale square a perceptual hash is computed from (§10).
 *
 * ffmpeg rather than sharp, which is what §10 originally named. Three reasons, in order of
 * weight: sharp is a large native dependency and this app already ships ffmpeg, so adding it
 * would mean two image stacks in a container that has to build for the NAS; ffmpeg reads
 * stills and video frames through the same call, so images and videos do not need separate
 * code paths; and ffmpeg handles the formats a real library actually contains — HEIC, odd
 * TIFF variants, animated WebP — without a second decoder behind a feature check.
 *
 * `execFile`, never `exec`: a path containing a quote or an ampersand would otherwise be
 * interpreted by a shell, and media filenames contain everything.
 */

/**
 * Long enough for a slow seek into a large file on a network share, short enough that one
 * pathological file cannot stall the queue. A frame that does not arrive is a skipped hash,
 * not a failed job.
 */
const DECODE_TIMEOUT_MS = 30_000;

const SAMPLES = PHASH_SIZE * PHASH_SIZE;

/**
 * `format=gray` after the scale, so the downscale averages colour before it is discarded.
 *
 * The other order — convert to gray and then scale — throws away the colour information
 * that should have contributed to each averaged pixel, which makes the result depend on the
 * source resolution. Two copies of one picture at different resolutions would then hash
 * differently, defeating the entire purpose.
 *
 * Aspect ratio is deliberately not preserved. A 16:9 frame and a 4:3 crop of the same scene
 * should hash alike, and squashing both to a square is what makes that true; letterboxing to
 * fit would instead encode the aspect ratio into the hash.
 */
const FILTER = `scale=${PHASH_SIZE}:${PHASH_SIZE}:flags=area,format=gray`;

const decode = async (args: string[]): Promise<Uint8Array | null> => {
    const ffmpeg = await resolveFfmpeg();

    try {
        const { stdout } = await execFileAsync(ffmpeg, capThreads(args), {
            timeout: DECODE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            // Binary on stdout: a string conversion mangles every byte above 0x7f, which is
            // most of a grayscale image.
            encoding: "buffer",
        });

        const pixels = stdout as unknown as Buffer;

        // A truncated or empty read is a frame that does not exist — a seek past the end, a
        // corrupt region. Returning null lets the caller skip it rather than hash padding.
        return pixels.length === SAMPLES ? new Uint8Array(pixels) : null;
    } catch {
        return null;
    }
};

/** The grayscale square for a still image. */
export const lumaFromImage = (imagePath: string): Promise<Uint8Array | null> =>
    decode([
        "-v",
        "error",
        "-i",
        imagePath,
        "-vf",
        FILTER,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
    ]);

/**
 * The grayscale square for one moment in a video.
 *
 * `-ss` before `-i` so ffmpeg seeks by index rather than decoding from the start — the
 * difference between a hash job that takes a second and one that decodes an hour of video to
 * reach a frame two thirds in, repeated once per sample.
 */
export const lumaFromVideo = (videoPath: string, atMs: number): Promise<Uint8Array | null> =>
    decode([
        "-v",
        "error",
        "-ss",
        (atMs / 1000).toFixed(3),
        "-i",
        videoPath,
        "-vf",
        FILTER,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
    ]);

/**
 * How many frames to sample from a video, and when.
 *
 * Evenly spaced across the middle 90%, avoiding both ends. Openings are logos, fades and
 * title cards; endings are credits — and those are exactly the frames that are *shared*
 * between unrelated files from the same source, so sampling them manufactures false matches
 * while telling you nothing about the content.
 *
 * The count is fixed rather than proportional to length, so that comparing a clip to a
 * feature compares like with like: the frame-ratio test in `compareVideos` measures against
 * the shorter side, and a proportional count would make short videos structurally unable to
 * reach the threshold.
 */
export const VIDEO_SAMPLE_COUNT = 12;

export const sampleOffsets = (durationMs: number | null): number[] => {
    // An unprobed or nonsensical duration still deserves an attempt; short fixed offsets
    // beat refusing to hash the file at all.
    if (!durationMs || durationMs <= 0) {
        return [1_000, 3_000, 6_000, 10_000];
    }

    const start = durationMs * 0.05;
    const span = durationMs * 0.9;

    return Array.from({ length: VIDEO_SAMPLE_COUNT }, (_, index) =>
        Math.floor(start + (span * index) / VIDEO_SAMPLE_COUNT)
    ).filter((offset) => offset >= 0 && offset < durationMs);
};
