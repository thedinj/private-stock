import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
    runReadPlan,
    type OcrSettings,
    type ReadBatch,
    type ReadPlanResult,
} from "@private-stock/core";

import { extractFrame, imageDimensions } from "./frames.js";
import { asFractions, readFrames, type FrameToRead } from "./ocr.js";

/**
 * Reading the text out of one file under given settings (§5d).
 *
 * The passes, early exits and floors are `runReadPlan` in core; this supplies the reading:
 * frames extracted with ffmpeg and read by Tesseract. Shared by the `ocr` job, which stores
 * what it returns, and the test bench's trials, which only compare it. The tuner reads frames
 * through `readFramesAt` too, into a cache it then replays through the same `runReadPlan` — so
 * all three agree about what a set of settings does.
 */

/** How a frame is read: the settings that change what Tesseract sees and how it looks. */
export type Recognition = Pick<OcrSettings, "psm" | "frameWidth" | "contrast">;

export interface FramesRead extends ReadBatch {
    /** The positions a frame could be taken at; the rest were past the end or unreadable. */
    positions: number[];
}

/**
 * Extract and read these positions.
 *
 * One ffmpeg call per position rather than one per pass with an `fps=` filter, which is a
 * deliberate departure from the shape §5d first described. An `fps=` filter has to decode
 * everything between the frames it keeps, and the sweep's frames are minutes apart: on a
 * two-hour film that is decoding two hours of video to keep twelve frames, against twelve
 * keyframe seeks. Recognition is batched into one Tesseract invocation regardless.
 *
 * A position that cannot be read is skipped rather than failed. A seek landing in a damaged
 * region is not a reason to abandon an item that has ninety-nine other frames.
 */
export const readFramesAt = async (
    sourcePath: string,
    hasTimeline: boolean,
    positions: number[],
    recognition: Recognition,
    workDir: string,
    signal?: AbortSignal
): Promise<FramesRead> => {
    const frames: FrameToRead[] = [];

    for (const atMs of positions) {
        const output = path.join(workDir, `f${atMs}.webp`);

        try {
            await extractFrame(sourcePath, output, {
                atMs: hasTimeline ? atMs : undefined,
                width: recognition.frameWidth,
                forRecognition: true,
                strongContrast: recognition.contrast,
            });

            frames.push({ path: output, atMs });
        } catch {
            // Skipped, not failed.
        }
    }

    if (frames.length === 0) {
        return { observations: [], framesRead: 0, positions: [] };
    }

    try {
        // Boxes are in pixels until the frame's own size is known, and every frame in a batch
        // was scaled the same way, so one measurement serves them all.
        const size = await imageDimensions(frames[0].path);
        const read = await readFrames(frames, workDir, recognition.psm, signal);

        return {
            observations: asFractions(
                read,
                size?.width ?? recognition.frameWidth,
                size?.height ?? recognition.frameWidth
            ),
            framesRead: frames.length,
            positions: frames.map((frame) => frame.atMs),
        };
    } finally {
        await Promise.all(frames.map((frame) => rm(frame.path, { force: true })));
    }
};

export const readText = async (
    sourcePath: string,
    hasTimeline: boolean,
    durationMs: number | null,
    settings: OcrSettings,
    signal?: AbortSignal
): Promise<ReadPlanResult> => {
    const workDir = await mkdtemp(path.join(tmpdir(), "ps-ocr-"));

    try {
        return await runReadPlan(hasTimeline ? durationMs : null, settings, (positions) =>
            readFramesAt(sourcePath, hasTimeline, positions, settings, workDir, signal)
        );
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
};
