import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { foldForComparison, ocrSettingsSchema } from "@private-stock/core";

import { resolveFfmpeg } from "./binaries.js";
import { readText } from "./readText.js";

/**
 * Reading a file under given settings, with the real ffmpeg and Tesseract (§5d "Settings and
 * the test bench").
 *
 * `readText` is what both the `ocr` job and the test bench read with, so what the bench shows
 * for a candidate is what the job would store with it. These check that the settings actually
 * reach the engine and the frame plan, not merely that they are accepted.
 */

const execFileAsync = promisify(execFile);

let workDir: string;

const TEXT = "AURORA";
const WATERMARK = "watermark.mp4";
const BLANK = "blank.mp4";
const DURATION_MS = 12_000;

const fontFile = (): string =>
    process.platform === "win32"
        ? "C\\:/Windows/Fonts/arialbd.ttf"
        : process.platform === "darwin"
          ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
          : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const generate = async (args: string[]): Promise<void> => {
    const ffmpeg = await resolveFfmpeg();
    await execFileAsync(ffmpeg, ["-v", "error", "-y", ...args], { timeout: 120_000 });
};

const video = (output: string, filter?: string): string[] => [
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=640x360:d=12:r=5",
    ...(filter ? ["-vf", filter] : []),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(workDir, output),
];

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "ps-readtext-it-"));

    await generate(
        video(
            WATERMARK,
            `drawtext=fontfile='${fontFile()}':text='${TEXT}':fontcolor=white:fontsize=34:x=40:y=30`
        )
    );
    await generate(video(BLANK));
}, 180_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

const defaults = ocrSettingsSchema.parse({});
const read = (file: string, settings = defaults) =>
    readText(path.join(workDir, file), true, DURATION_MS, settings);
const found = (result: Awaited<ReturnType<typeof read>>): string[] =>
    result.worth.map((finding) => foldForComparison(finding.text));

describe("readText", () => {
    it("reads a watermark under the default settings", async () => {
        const result = await read(WATERMARK);

        expect(found(result)).toContain(foldForComparison(TEXT));
        expect(result.framesRead).toBeGreaterThan(0);
    }, 120_000);

    it("stops after the probe when nothing is there", async () => {
        const result = await read(BLANK);

        expect(result.worth).toEqual([]);
        expect(result.framesRead).toBeLessThanOrEqual(defaults.probeFrames);
    }, 120_000);

    it("reads no more frames than it is allowed", async () => {
        const result = await read(WATERMARK, {
            ...defaults,
            maxFrames: 6,
            confirmedOccurrences: 60,
        });

        expect(result.framesRead).toBeLessThanOrEqual(6);
    }, 120_000);

    it("applies the storage floors it is given", async () => {
        // A floor nothing real can clear: the same reading, none of it kept.
        const result = await read(WATERMARK, { ...defaults, confidenceMin: 1 });

        expect(result.worth).toEqual([]);
    }, 120_000);

    it("still reads clear text with another layout mode and the strong contrast boost", async () => {
        const result = await read(WATERMARK, { ...defaults, psm: 12, contrast: true });

        expect(found(result)).toContain(foldForComparison(TEXT));
    }, 120_000);
});
