import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { foldForComparison, ocrFramePlan, reconcileText } from "@private-stock/core";

import { resolveFfmpeg } from "./binaries.js";
import { extractFrame, imageDimensions } from "./frames.js";
import { asFractions, readFrames } from "./ocr.js";

const execFileAsync = promisify(execFile);

/**
 * Reading text off real frames with real Tesseract (§5d).
 *
 * An integration test because everything worth verifying here belongs to the engine: that a
 * batch of frames comes back as one result per frame in the order they were sent, that word
 * boxes are where the words are, and that a string burned into a video survives extraction,
 * preprocessing, recognition and reconciliation end to end. None of that can be asserted
 * against a fixture — the reconciler's own tests do that, on what frames *said*. This one is
 * about whether the frames say it.
 *
 * The fixture is generated rather than checked in, with known text, so the whole pipeline can
 * be exercised without any real library's content.
 */

let workDir: string;

/** A watermark in one corner for the whole clip, which is the case this feature is for. */
const WATERMARK = "watermark.mp4";
/** Nothing but black: the answer "there is no text here" has to be reachable. */
const BLANK = "blank.mp4";

const TEXT = "AURORA";

/**
 * Whatever font the machine has.
 *
 * `drawtext` needs a real font file and the test must not care which: CI runners, a Windows
 * dev box and a NAS have nothing in common here. Recognition is being tested, not typography.
 */
const fontFile = (): string => {
    const candidates = [
        // The colon is escaped for ffmpeg's filter parser, where a drive letter's colon is
        // otherwise argument syntax.
        "C\\:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ];

    return candidates[process.platform === "win32" ? 0 : process.platform === "darwin" ? 2 : 1];
};

const generate = async (args: string[]): Promise<void> => {
    const ffmpeg = await resolveFfmpeg();
    await execFileAsync(ffmpeg, ["-v", "error", "-y", ...args], { timeout: 120_000 });
};

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "ps-ocr-it-"));

    await generate([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:d=12:r=5",
        "-vf",
        `drawtext=fontfile='${fontFile()}':text='${TEXT}':fontcolor=white:fontsize=34:x=40:y=30`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, WATERMARK),
    ]);

    await generate([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:d=12:r=5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, BLANK),
    ]);
}, 180_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

/** Extract the planned probe frames of a fixture, as the job would. */
const probeFrames = async (file: string): Promise<{ path: string; atMs: number }[]> => {
    const frames = [];

    for (const atMs of ocrFramePlan(12_000).probe) {
        const output = path.join(workDir, `${file}-${atMs}.webp`);

        await extractFrame(path.join(workDir, file), output, {
            atMs,
            width: 1280,
            forRecognition: true,
        });

        frames.push({ path: output, atMs });
    }

    return frames;
};

describe("reading a batch of frames", () => {
    it("returns one result per frame, attributed to the right moment", async () => {
        const frames = await probeFrames(WATERMARK);
        const observations = await readFrames(frames, workDir, 11);

        // The batch is one invocation over a file list, so the only thing keeping a finding
        // attached to its timestamp is that the pages come back in the order they were sent.
        // If that ever stops being true, the details panel offers to jump to a frame that
        // never held the text.
        const moments = new Set(observations.map((observation) => observation.atMs));

        expect(observations.length).toBeGreaterThan(0);
        expect(moments.size).toBe(frames.length);

        for (const observation of observations) {
            expect(frames.map((frame) => frame.atMs)).toContain(observation.atMs);
        }
    }, 120_000);

    it("reads the text that was burned in, from where it was burned in", async () => {
        const frames = await probeFrames(WATERMARK);
        const size = await imageDimensions(frames[0].path);
        const observations = asFractions(
            await readFrames(frames, workDir, 11),
            size?.width ?? 1280,
            size?.height ?? 720
        );

        const findings = reconcileText(observations, frames.length);
        const found = findings.find(
            (finding) => foldForComparison(finding.text) === foldForComparison(TEXT)
        );

        expect(found).toBeDefined();
        // Drawn in the upper left, and the position has to survive the pixels-to-fractions
        // conversion or nothing will cluster and nothing will be drawable later.
        expect(found?.box.x).toBeLessThan(0.3);
        expect(found?.box.y).toBeLessThan(0.3);
        // On screen for the whole clip: every probe frame should have seen it.
        expect(found?.stability).toBeGreaterThan(0.8);
    }, 120_000);

    it("finds nothing in a file that has nothing", async () => {
        const frames = await probeFrames(BLANK);
        const observations = await readFrames(frames, workDir, 11);

        // The probe's exit, and the reason the feature is affordable at all. Recognition
        // returns *something* from almost any frame, so what matters is that nothing here
        // recurs in the same place.
        const findings = reconcileText(observations, frames.length);

        expect(findings.filter((finding) => finding.occurrences >= 2)).toEqual([]);
    }, 120_000);

    it("has nothing to say when asked about no frames", async () => {
        expect(await readFrames([], workDir, 11)).toEqual([]);
    });
});
