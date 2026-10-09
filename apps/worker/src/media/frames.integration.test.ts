import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "./binaries.js";
import { NEAR_BLACK_LUMINANCE, averageLuminance, extractFrame, imageDimensions } from "./frames.js";

const execFileAsync = promisify(execFile);

/**
 * Frame extraction, against real ffmpeg and real generated files.
 *
 * These are integration tests because the thing worth verifying is not our arithmetic — it is
 * what ffmpeg actually does. In particular the claim that a cover "skips near-black frames"
 * rests entirely on the behaviour of the `thumbnail` filter, which no unit test can assert
 * and which would otherwise only be discovered to be wrong by looking at a library full of
 * black tiles.
 */

let workDir: string;

/** A short clip that fades in from black, which is how a great many videos open. */
const FADE_IN = "fade-in.mp4";
/** Uniformly black from start to end — nothing to rescue. */
const ALL_BLACK = "all-black.mp4";
/** A small still, for the no-upscaling rule. */
const SMALL_IMAGE = "small.png";
/**
 * A long file holding exactly one frame.
 *
 * Real examples in a real library: QuickTime slideshow exports reporting `mjpeg`, a three
 * minute duration and `nb_frames=1`. Every offset a cover would sample seeks past the only
 * frame there is, so the file had no cover at all until the first-frame fallback existed.
 */
const ONE_FRAME = "one-frame.mov";

const generate = async (args: string[]): Promise<void> => {
    const ffmpeg = await resolveFfmpeg();
    await execFileAsync(ffmpeg, ["-v", "error", "-y", ...args], { timeout: 60_000 });
};

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-frames-"));

    // Ten seconds of white, fading in from black over the first four. At ten frames a second
    // the `thumbnail` filter's batch spans the fade, so choosing well is possible — and
    // choosing badly is what the old "just seek to 10%" approach would do.
    await generate([
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=320x180:r=10:d=10",
        "-vf",
        "fade=t=in:st=0:d=4",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, FADE_IN),
    ]);

    await generate([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:r=10:d=5",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, ALL_BLACK),
    ]);

    await generate([
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x48:d=1",
        "-frames:v",
        "1",
        path.join(workDir, SMALL_IMAGE),
    ]);

    // One frame, stretched over 178 seconds by the frame rate. `-frames:v 1` writes a single
    // picture and `-r 1/178` declares that picture 178 seconds long, which is the shape the
    // real files have: a duration that invites sampling and nothing to sample.
    await generate([
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:d=1",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-r",
        "1/178",
        path.join(workDir, ONE_FRAME),
    ]);
}, 120_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

const source = (name: string): string => path.join(workDir, name);
const output = (name: string): string => path.join(workDir, "out", name);

describe("averageLuminance", () => {
    it("reads near zero for black and high for white", async () => {
        await extractFrame(source(ALL_BLACK), output("black.webp"), { atMs: 1000, width: 320 });
        await extractFrame(source(FADE_IN), output("white.webp"), { atMs: 8000, width: 320 });

        const black = await averageLuminance(output("black.webp"));
        const white = await averageLuminance(output("white.webp"));

        expect(black).toBeLessThan(NEAR_BLACK_LUMINANCE);
        expect(white).toBeGreaterThan(200);
    });
});

describe("extractFrame", () => {
    it("takes the exact frame asked for when not choosing a representative one", async () => {
        // The capture case: someone paused here and pressed the button, so this frame is what
        // they meant — even though it is black.
        await extractFrame(source(FADE_IN), output("exact.webp"), { atMs: 0, width: 320 });

        expect(await averageLuminance(output("exact.webp"))).toBeLessThan(NEAR_BLACK_LUMINANCE);
    });

    it("skips the fade when asked for a representative frame", async () => {
        // The cover case, and the whole reason `thumbnail` is in the filter chain: seeking to
        // the same position gives a black frame, and this must not.
        await extractFrame(source(FADE_IN), output("representative.webp"), {
            atMs: 0,
            width: 320,
            representative: true,
        });

        expect(await averageLuminance(output("representative.webp"))).toBeGreaterThan(
            NEAR_BLACK_LUMINANCE
        );
    });

    it("still produces a frame when every candidate is black", async () => {
        // A genuinely dark video must get a dark cover, not no cover.
        await extractFrame(source(ALL_BLACK), output("dark.webp"), {
            atMs: 500,
            width: 320,
            representative: true,
        });

        const { width, height } = await imageDimensions(output("dark.webp"));

        expect(width).toBe(320);
        expect(height).toBe(180);
    });

    it("finds nothing past the only frame of a single-frame file", async () => {
        // The failure the fallback exists for, pinned to ffmpeg rather than to our reasoning.
        // 10% of 178s is 17.8s; the one frame is at zero, so there is nothing to encode and
        // ffmpeg exits non-zero. If this ever starts passing, the fallback has become dead
        // code and should go.
        await expect(
            extractFrame(source(ONE_FRAME), output("past-the-end.webp"), {
                atMs: 17_800,
                width: 320,
                representative: true,
            })
        ).rejects.toThrow();
    });

    it("takes the first frame of a single-frame file when asked for offset zero", async () => {
        // The other half: the fallback is worth attempting because this succeeds.
        await extractFrame(source(ONE_FRAME), output("first-frame.webp"), {
            atMs: 0,
            width: 320,
            representative: true,
        });

        const { width, height } = await imageDimensions(output("first-frame.webp"));

        expect(width).toBe(320);
        expect(height).toBe(180);
    });

    it("scales down to the requested width, preserving the aspect ratio", async () => {
        await extractFrame(source(FADE_IN), output("scaled.webp"), { atMs: 8000, width: 160 });

        expect(await imageDimensions(output("scaled.webp"))).toEqual({ width: 160, height: 90 });
    });

    it("never upscales a source smaller than the target", async () => {
        // A 64px image blown up to 640 is blurry and costs far more bytes to say nothing more.
        await extractFrame(source(SMALL_IMAGE), output("small.webp"), { width: 640 });

        expect(await imageDimensions(output("small.webp"))).toEqual({ width: 64, height: 48 });
    });

    it("creates the output directory rather than failing on a missing one", async () => {
        const nested = path.join(workDir, "a", "b", "c", "deep.webp");

        await extractFrame(source(FADE_IN), nested, { atMs: 8000, width: 160 });

        expect((await imageDimensions(nested)).width).toBe(160);
    });

    it("fails rather than writing a broken file when the source is not media", async () => {
        await expect(
            extractFrame(source("does-not-exist.mp4"), output("nope.webp"), { width: 320 })
        ).rejects.toThrow();
    });
});
