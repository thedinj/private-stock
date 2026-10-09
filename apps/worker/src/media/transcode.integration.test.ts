import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_TRANSCODE_SETTINGS, assessPlayback } from "@private-stock/core";

import { resolveFfmpeg, resolveFfprobe } from "./binaries.js";
import { runTranscode } from "./transcode.js";

const execFileAsync = promisify(execFile);

/**
 * Transcoding, against real ffmpeg.
 *
 * The unit tests prove the argument list is what we intended. Only running it proves that
 * what we intended actually works — that faststart lands where a browser needs it, that a
 * remux really does copy rather than re-encode, and that a killed job leaves nothing behind
 * that the player would later mistake for a finished file.
 */

let workDir: string;

/** H.264/AAC in MKV: the common downloaded-library case, needing only a container change. */
const MKV_GOOD_STREAMS = "good-streams.mkv";
/** An unplayable video codec, so the video genuinely has to be re-encoded. */
const NEEDS_ENCODE = "needs-encode.mkv";
/**
 * Odd dimensions, below the height cap, in a codec that has to be re-encoded.
 *
 * Every other fixture here is 640x360 -- even on both axes and comfortably under the cap -- so
 * the whole suite passed while H.264 refused an entire category of real file. Encoded as ffv1
 * precisely because libx264 cannot represent this size at all, which is the bug.
 */
const ODD_DIMENSIONS = "odd-445x345.mkv";

const probe = async (file: string): Promise<Record<string, unknown>> => {
    const { stdout } = await execFileAsync(await resolveFfprobe(), [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
    ]);

    return JSON.parse(stdout) as Record<string, unknown>;
};

beforeAll(async () => {
    const ffmpeg = await resolveFfmpeg();
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-transcode-"));

    await execFileAsync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=640x360:r=15:d=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        path.join(workDir, MKV_GOOD_STREAMS),
    ]);

    await execFileAsync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=640x360:r=15:d=6",
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, NEEDS_ENCODE),
    ]);

    await execFileAsync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=445x345:r=15:d=2",
        "-c:v",
        "ffv1",
        path.join(workDir, ODD_DIMENSIONS),
    ]);
}, 240_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("runTranscode", () => {
    /**
     * The regression: H.264 with yuv420p cannot encode an odd dimension at all.
     *
     * A 445x345 source sat below the height cap, so the scale filter was skipped entirely and
     * the dimensions reached libx264 untouched:
     *
     *     [libx264] width not divisible by 2 (445x345)
     *
     * Forcing the filter on was not enough either -- `-2` fixed the width and left the height
     * at 345. Both axes have to be rounded, which is why this asserts the output size rather
     * than merely that the command succeeded.
     */
    it("encodes a source whose dimensions are odd, rounding both down to even", async () => {
        const output = path.join(workDir, "out", "odd.mp4");

        await runTranscode({
            inputPath: path.join(workDir, ODD_DIMENSIONS),
            outputPath: output,
            settings: DEFAULT_TRANSCODE_SETTINGS,
            remuxOnly: false,
            videoNeedsEncode: true,
            audioNeedsEncode: false,
            durationMs: 2_000,
        });

        const streams = (await probe(output)).streams as {
            codec_type: string;
            width: number;
            height: number;
        }[];
        const video = streams.find((stream) => stream.codec_type === "video");

        expect(video).toMatchObject({ width: 444, height: 344 });
        // Not merely even: the source was already under the cap, so it must not have been
        // scaled to something unrelated on the way past.
        expect(video!.width % 2).toBe(0);
        expect(video!.height % 2).toBe(0);
    }, 120_000);

    it("remuxes good streams without re-encoding them", async () => {
        const output = path.join(workDir, "out", "remuxed.mp4");
        const before = await probe(path.join(workDir, MKV_GOOD_STREAMS));

        const result = await runTranscode({
            inputPath: path.join(workDir, MKV_GOOD_STREAMS),
            outputPath: output,
            settings: DEFAULT_TRANSCODE_SETTINGS,
            remuxOnly: true,
            videoNeedsEncode: false,
            audioNeedsEncode: false,
            durationMs: 6_000,
        });

        expect(result.remux).toBe(true);

        const after = await probe(output);
        const videoBefore = (before.streams as { codec_type: string; codec_name: string }[]).find(
            (stream) => stream.codec_type === "video"
        );
        const videoAfter = (after.streams as { codec_type: string; codec_name: string }[]).find(
            (stream) => stream.codec_type === "video"
        );

        // A copy, not a re-encode: same codec, and the result is now directly playable.
        expect(videoAfter?.codec_name).toBe(videoBefore?.codec_name);
        expect(
            assessPlayback({
                kind: "video",
                container: (after.format as { format_name: string }).format_name,
                codec: videoAfter?.codec_name ?? null,
                videoProfile: null,
                pixFmt: null,
                audioCodec: "aac",
                probedAt: "now",
            }).directPlay
        ).toBe(true);
    });

    it("re-encodes a video codec browsers cannot play", async () => {
        const output = path.join(workDir, "out", "encoded.mp4");

        const result = await runTranscode({
            inputPath: path.join(workDir, NEEDS_ENCODE),
            outputPath: output,
            settings: DEFAULT_TRANSCODE_SETTINGS,
            remuxOnly: false,
            videoNeedsEncode: true,
            audioNeedsEncode: false,
            durationMs: 6_000,
        });

        expect(result.remux).toBe(false);

        const after = await probe(output);
        const video = (after.streams as { codec_type: string; codec_name: string }[]).find(
            (stream) => stream.codec_type === "video"
        );

        expect(video?.codec_name).toBe("h264");
    });

    it("puts the moov atom at the front, or a browser must download the file first", async () => {
        const output = path.join(workDir, "out", "faststart.mp4");

        await runTranscode({
            inputPath: path.join(workDir, MKV_GOOD_STREAMS),
            outputPath: output,
            settings: DEFAULT_TRANSCODE_SETTINGS,
            remuxOnly: true,
            videoNeedsEncode: false,
            audioNeedsEncode: false,
            durationMs: 6_000,
        });

        // Read the top-level MP4 boxes in order. `moov` before `mdat` is what makes the file
        // streamable; the reverse plays only after a full download, which defeats the point.
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(output);

        const boxes: string[] = [];
        let offset = 0;

        while (offset + 8 <= bytes.length && boxes.length < 10) {
            const size = bytes.readUInt32BE(offset);
            boxes.push(bytes.toString("ascii", offset + 4, offset + 8));

            if (size < 8) break;
            offset += size;
        }

        expect(boxes).toContain("moov");
        expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
    });

    it("reports progress as a fraction that only moves forward", async () => {
        const seen: number[] = [];

        await runTranscode({
            inputPath: path.join(workDir, NEEDS_ENCODE),
            outputPath: path.join(workDir, "out", "progress.mp4"),
            settings: DEFAULT_TRANSCODE_SETTINGS,
            remuxOnly: false,
            videoNeedsEncode: true,
            audioNeedsEncode: false,
            durationMs: 6_000,
            onProgress: (fraction) => seen.push(fraction),
        });

        expect(seen.length).toBeGreaterThan(0);

        for (const fraction of seen) {
            expect(fraction).toBeGreaterThanOrEqual(0);
            expect(fraction).toBeLessThanOrEqual(1);
        }

        // Progress that goes backwards reads as a stuck job; the queue also uses these as the
        // job's heartbeat.
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    });

    it("leaves nothing behind when it fails", async () => {
        const dir = path.join(workDir, "failure");

        await expect(
            runTranscode({
                inputPath: path.join(workDir, "does-not-exist.mkv"),
                outputPath: path.join(dir, "never.mp4"),
                settings: DEFAULT_TRANSCODE_SETTINGS,
                remuxOnly: true,
                videoNeedsEncode: false,
                audioNeedsEncode: false,
                durationMs: 6_000,
            })
        ).rejects.toThrow();

        // Not even the partial: it sits in the directory the web app serves variants from,
        // and a truncated MP4 there is indistinguishable by name from a complete one.
        expect(await readdir(dir)).toEqual([]);
    });

    /**
     * Cancellation, end to end against a real encoder (§18.7).
     *
     * The claim worth proving with ffmpeg actually running is the cleanup: the child is
     * killed partway through a file it is still writing, and what it had written must not
     * survive. A unit test could only prove the promise rejects.
     */
    it("kills the encoder on cancellation and leaves no partial behind", async () => {
        const dir = path.join(workDir, "cancelled");
        const controller = new AbortController();

        const running = runTranscode({
            inputPath: path.join(workDir, NEEDS_ENCODE),
            outputPath: path.join(dir, "stopped.mp4"),
            settings: DEFAULT_TRANSCODE_SETTINGS,
            remuxOnly: false,
            videoNeedsEncode: true,
            audioNeedsEncode: false,
            durationMs: 6_000,
            // Cancel once ffmpeg has written something, so the test is about removing a
            // partial file rather than about never having created one.
            onProgress: () => controller.abort(),
            signal: controller.signal,
        });

        await expect(running).rejects.toThrow(/cancelled/i);
        expect(await readdir(dir)).toEqual([]);
    });

    /** Nothing is spawned at all when the signal is already aborted at the call. */
    it("does not start an encoder that was cancelled before it began", async () => {
        const dir = path.join(workDir, "cancelled-early");

        await expect(
            runTranscode({
                inputPath: path.join(workDir, NEEDS_ENCODE),
                outputPath: path.join(dir, "never-started.mp4"),
                settings: DEFAULT_TRANSCODE_SETTINGS,
                remuxOnly: false,
                videoNeedsEncode: true,
                audioNeedsEncode: false,
                durationMs: 6_000,
                signal: AbortSignal.abort(),
            })
        ).rejects.toThrow(/cancelled/i);

        expect(await readdir(dir)).toEqual([]);
    });

    it("surfaces ffmpeg's own words, not just an exit code", async () => {
        // This becomes the job's lastError, which is the only thing an admin sees.
        await expect(
            runTranscode({
                inputPath: path.join(workDir, "missing.mkv"),
                outputPath: path.join(workDir, "out", "nope.mp4"),
                settings: DEFAULT_TRANSCODE_SETTINGS,
                remuxOnly: true,
                videoNeedsEncode: false,
                audioNeedsEncode: false,
                durationMs: null,
            })
        ).rejects.toThrow(/missing\.mkv/i);
    });

    it("stops when aborted, and writes no output", async () => {
        const controller = new AbortController();
        const output = path.join(workDir, "cancelled", "partial.mp4");

        const running = runTranscode({
            inputPath: path.join(workDir, NEEDS_ENCODE),
            outputPath: output,
            settings: { ...DEFAULT_TRANSCODE_SETTINGS, preset: "slow" },
            remuxOnly: false,
            videoNeedsEncode: true,
            audioNeedsEncode: false,
            durationMs: 6_000,
            signal: controller.signal,
        });

        controller.abort();

        await expect(running).rejects.toThrow(/cancel/i);
        await expect(stat(output)).rejects.toThrow();
    });
});
