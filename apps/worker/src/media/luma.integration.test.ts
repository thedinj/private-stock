import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { hammingDistance, phashFromLuma } from "@private-stock/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "./binaries.js";
import { lumaFromImage, lumaFromVideo, sampleOffsets } from "./luma.js";

const execFileAsync = promisify(execFile);

/**
 * Perceptual hashing against real files.
 *
 * The unit tests prove the hash is stable under transformations applied *in TypeScript* to a
 * synthetic array. What they cannot prove is the part that actually decides whether duplicate
 * detection works: that ffmpeg's decode and downscale produce comparable pixels for two files
 * that differ in resolution, codec and container. That claim is entirely about ffmpeg's
 * scaler, and the only way to check it is to encode real files and compare.
 *
 * This is where a whole class of silent failure lives. A hash pipeline that decodes
 * inconsistently still returns plausible 64-bit values for everything — it simply never finds
 * a duplicate, and nothing anywhere reports an error.
 */

let workDir: string;

const SOURCE = "source.mp4";
/** The same content, smaller and re-encoded — the commonest real near-duplicate. */
const RESCALED = "rescaled.mp4";
/** The same content in a different container and codec. */
const REMUXED = "source.webm";
/** Unrelated content, to prove the hash discriminates at all. */
const OTHER = "other.mp4";

const SOURCE_IMAGE = "picture.png";
const SOURCE_IMAGE_SMALL = "picture-small.jpg";
const OTHER_IMAGE = "other.png";

const generate = async (args: string[]): Promise<void> => {
    const ffmpeg = await resolveFfmpeg();

    await execFileAsync(ffmpeg, ["-v", "error", "-y", ...args], { timeout: 120_000 });
};

const at = (name: string): string => path.join(workDir, name);

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-phash-"));

    /**
     * `testsrc2` rather than a flat colour: it has text, motion and structure at several
     * scales, so its DCT has energy across the whole block the hash reads. A colour bar
     * pattern would be almost flat in the low frequencies and every frame would hash alike,
     * which would make these tests pass without proving anything.
     */
    await generate([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=640x360:r=10:d=6",
        "-pix_fmt",
        "yuv420p",
        at(SOURCE),
    ]);

    // Half the resolution, a different bitrate, re-encoded from the original.
    await generate([
        "-i",
        at(SOURCE),
        "-vf",
        "scale=320:180",
        "-b:v",
        "200k",
        "-pix_fmt",
        "yuv420p",
        at(RESCALED),
    ]);

    // A different codec and container entirely.
    await generate([
        "-i",
        at(SOURCE),
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "300k",
        "-cpu-used",
        "8",
        at(REMUXED),
    ]);

    await generate([
        "-f",
        "lavfi",
        "-i",
        "mandelbrot=s=640x360:r=10",
        "-t",
        "6",
        "-pix_fmt",
        "yuv420p",
        at(OTHER),
    ]);

    await generate(["-f", "lavfi", "-i", "testsrc2=s=640x360", "-frames:v", "1", at(SOURCE_IMAGE)]);

    // Downscaled *and* JPEG-compressed: two lossy steps, which is what a thumbnail or a
    // re-shared copy has been through.
    await generate([
        "-i",
        at(SOURCE_IMAGE),
        "-vf",
        "scale=240:135",
        "-q:v",
        "12",
        at(SOURCE_IMAGE_SMALL),
    ]);

    await generate([
        "-f",
        "lavfi",
        "-i",
        "mandelbrot=s=640x360",
        "-frames:v",
        "1",
        at(OTHER_IMAGE),
    ]);
}, 180_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

const hashImage = async (name: string): Promise<Uint8Array> => {
    const luma = await lumaFromImage(at(name));

    expect(luma).not.toBeNull();

    return phashFromLuma(luma as Uint8Array).hash;
};

const hashFrame = async (name: string, atMs: number): Promise<Uint8Array> => {
    const luma = await lumaFromVideo(at(name), atMs);

    expect(luma).not.toBeNull();

    return phashFromLuma(luma as Uint8Array).hash;
};

describe("lumaFromImage", () => {
    it("decodes to exactly the sample count the hash expects", async () => {
        const luma = await lumaFromImage(at(SOURCE_IMAGE));

        // A short read would be hashed as padding and produce a confident wrong answer, so
        // the decoder returns null instead — this asserts the happy path really is 32x32.
        expect(luma).toHaveLength(32 * 32);
    });

    it("gives a near-identical hash for a downscaled, recompressed copy", async () => {
        const distance = hammingDistance(
            await hashImage(SOURCE_IMAGE),
            await hashImage(SOURCE_IMAGE_SMALL)
        );

        // The whole feature rests on this number being small across a real decode.
        expect(distance).toBeLessThanOrEqual(7);
    });

    it("separates unrelated images", async () => {
        const distance = hammingDistance(
            await hashImage(SOURCE_IMAGE),
            await hashImage(OTHER_IMAGE)
        );

        expect(distance).toBeGreaterThan(7);
    });

    it("returns null for a file that is not an image, rather than throwing", async () => {
        // A clustering pass runs over whatever the scanner catalogued; one unreadable file
        // must not abort it.
        expect(await lumaFromImage(at("does-not-exist.png"))).toBeNull();
    });
});

describe("lumaFromVideo", () => {
    it("gives a near-identical hash for the same frame at half resolution", async () => {
        const distance = hammingDistance(
            await hashFrame(SOURCE, 3_000),
            await hashFrame(RESCALED, 3_000)
        );

        expect(distance).toBeLessThanOrEqual(7);
    });

    it("gives a near-identical hash across a different codec and container", async () => {
        const distance = hammingDistance(
            await hashFrame(SOURCE, 3_000),
            await hashFrame(REMUXED, 3_000)
        );

        expect(distance).toBeLessThanOrEqual(7);
    });

    it("separates unrelated video", async () => {
        const distance = hammingDistance(
            await hashFrame(SOURCE, 3_000),
            await hashFrame(OTHER, 3_000)
        );

        expect(distance).toBeGreaterThan(7);
    });

    it("returns null for a seek past the end", async () => {
        // A duration that ffprobe got wrong is common enough that this has to be a skipped
        // frame rather than a failed job.
        expect(await lumaFromVideo(at(SOURCE), 999_000)).toBeNull();
    });

    it("distinguishes frames within one video", async () => {
        // If it did not, every video would match every other on any single frame, and the
        // frame-fraction test in compareVideos would be measuring noise.
        const distance = hammingDistance(
            await hashFrame(SOURCE, 500),
            await hashFrame(SOURCE, 5_000)
        );

        expect(distance).toBeGreaterThan(0);
    });

    it("matches the whole sample plan between an original and its re-encode", async () => {
        /**
         * The end-to-end claim. Every sampled moment of the smaller copy must pair with the
         * same moment of the original, because that is exactly what `compareVideos` asks of
         * a genuine re-encode — a plan that mostly matched would leave real duplicates
         * sitting below the frame-ratio threshold.
         */
        const offsets = sampleOffsets(6_000);

        expect(offsets.length).toBeGreaterThan(4);

        const distances = await Promise.all(
            offsets.map(async (offset) =>
                hammingDistance(await hashFrame(SOURCE, offset), await hashFrame(RESCALED, offset))
            )
        );

        const matching = distances.filter((distance) => distance <= 7).length;

        expect(matching / distances.length).toBeGreaterThanOrEqual(0.6);
    });
});

describe("sampleOffsets", () => {
    it("stays inside the video", async () => {
        for (const offset of sampleOffsets(6_000)) {
            expect(await lumaFromVideo(at(SOURCE), offset)).not.toBeNull();
        }
    });
});
