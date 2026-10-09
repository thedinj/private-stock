import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { TextObservation } from "@private-stock/core";
import { resolveTesseract } from "@private-stock/core/server";

// Aliased so the call site reads as a plain exec: the only difference is that background
// work lowers its child's priority (§7c).
import { execFilePolitely as execFileAsync } from "./politeSpawn.js";
import { threadsPerJob } from "../throttle.js";

/**
 * Reading text off extracted frames with Tesseract (§5d).
 *
 * Recognition only. What the frames said is reconciled by `@private-stock/core`, which is
 * pure and knows nothing about engines — the split is what lets the hard part be tested
 * against fixtures and the engine be swapped without touching it.
 */

/** Per invocation, not per frame. A batch of sixty frames is still one process. */
const OCR_TIMEOUT_MS = 10 * 60_000;

/** A word Tesseract reported, before anything has been decided about it. */
interface RawWord {
    /** 1-based, and the index of the image in the batch that produced this word. */
    page: number;
    text: string;
    confidence: number;
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Parse Tesseract's TSV.
 *
 * Level 5 is a word. Word boxes rather than lines because it was measured: Tesseract
 * re-segments lines from scratch on every frame, so a line's box moves between frames and
 * position — the one grouping key that does not depend on the text having been read correctly
 * — stops working. Words hold still.
 *
 * A batch produces one table with a single header, not one table per image: `page_num` is
 * what says which image a word came from. There is no separator to split on, and an image
 * that produced no text contributes no rows at all rather than an empty section — so nothing
 * about the output's *shape* can be used to line results up with inputs.
 */
const parseTsv = (tsv: string): RawWord[] =>
    tsv
        .split("\n")
        .map((row) => row.split("\t"))
        .filter(
            (columns) =>
                columns.length >= 12 &&
                columns[0] === "5" &&
                columns[11]?.trim() &&
                Number(columns[10]) >= 0 &&
                Number.isFinite(Number(columns[1]))
        )
        .map((columns) => ({
            page: Number(columns[1]),
            text: columns[11].trim(),
            confidence: Number(columns[10]) / 100,
            left: Number(columns[6]),
            top: Number(columns[7]),
            width: Number(columns[8]),
            height: Number(columns[9]),
        }));

export interface FrameToRead {
    path: string;
    atMs: number;
}

/**
 * Read a batch of frames in one invocation.
 *
 * Tesseract takes a file listing all the images to read, and the reason to use it is
 * measured: a process per frame spent most of its time starting up, and the engine loads its
 * language data once per process. The list is written beside the frames rather than passed on
 * the command line, which also sidesteps a media library's worth of awkward filenames.
 *
 * Output is one TSV per input, separated by a page break, in the order given — so a frame
 * whose recognition produced nothing still occupies its place and the timestamps stay aligned
 * with the images they came from.
 */
export const readFrames = async (
    frames: FrameToRead[],
    workDir: string,
    /** Tesseract's page segmentation mode; 11, sparse text, unless an administrator chose. */
    pageMode: number,
    signal?: AbortSignal
): Promise<TextObservation[]> => {
    if (frames.length === 0) {
        return [];
    }

    const tesseract = resolveTesseract();
    const listPath = path.join(workDir, "frames.txt");

    await writeFile(listPath, frames.map((frame) => frame.path).join("\n"), "utf8");

    const { stdout } = await execFileAsync(
        tesseract,
        [listPath, "stdout", "--psm", String(pageMode), "tsv"],
        {
            timeout: OCR_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
            signal,
            // Tesseract's OpenMP pool sizes itself from the host's cores, like ffmpeg, and is
            // held to the job's slot the same way (`capThreads`).
            env: { ...process.env, OMP_THREAD_LIMIT: String(threadsPerJob()) },
        }
    );

    const words = parseTsv(stdout);

    /**
     * A page number outside the batch means the results cannot be lined up with the images.
     *
     * A finding attributed to the wrong moment is worse than no finding: the details panel
     * would offer to jump to a frame that never held the text, and the reconciler would be
     * clustering positions from one frame against timestamps from another. So the batch is
     * abandoned rather than reported against guessed times.
     */
    const highest = words.reduce((most, word) => Math.max(most, word.page), 0);

    if (highest > frames.length) {
        throw new Error(
            `Tesseract reported page ${highest} of a ${frames.length}-frame batch; ` +
                "cannot attribute text to a timestamp"
        );
    }

    return words.map((word) => ({
        atMs: frames[word.page - 1].atMs,
        text: word.text,
        confidence: word.confidence,
        box: {
            x: word.left,
            y: word.top,
            w: word.width,
            h: word.height,
        },
    }));
};

/**
 * Pixel boxes to fractions of the frame.
 *
 * The reconciler compares positions across frames, and stores them for drawing later, so they
 * have to be resolution-independent: the same watermark in a 1080p file and a 720p one must
 * compare equal, and a change to the pre-OCR scaling must not silently stop everything
 * grouping. Frame dimensions are the true denominator and are known here.
 */
export const asFractions = (
    observations: TextObservation[],
    frameWidth: number,
    frameHeight: number
): TextObservation[] =>
    observations.map((observation) => ({
        ...observation,
        box: {
            x: observation.box.x / frameWidth,
            y: observation.box.y / frameHeight,
            w: observation.box.w / frameWidth,
            h: observation.box.h / frameHeight,
        },
    }));
