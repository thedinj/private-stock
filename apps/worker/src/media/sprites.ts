import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import {
    SPRITE_COLUMNS,
    SPRITE_ROWS,
    SPRITE_TILE_WIDTH,
    type SpriteLayout,
} from "@private-stock/core";

import { resolveFfmpeg, resolveFfprobe } from "./binaries.js";
// Aliased so the call sites read unchanged: the only difference from a bare
// `execFile` is that background work lowers its child's priority (§7c).
import { execFilePolitely as execFileAsync, runPolitely } from "./politeSpawn.js";
import { capThreads } from "./ffmpegThreads.js";
import { imageDimensions } from "./frames.js";

/**
 * Rendering scrubber sprite sheets with ffmpeg.
 *
 * Mostly this does not seek: a hundred seeks is a hundred ffmpeg processes, and spawning them
 * measured slower than reading the file through once. So one process reads the whole file, and
 * the only question is how much of it has to be *decoded*. Where the keyframes are close enough
 * together, only they are — see `keyframesSuffice`. Otherwise every frame is, which makes this
 * the most expensive artifact job there is, and is why `sprite` concurrency is 1 — two of these
 * at once on a NAS leaves nothing for serving pages.
 *
 * **Except where the decoder cannot skip** (`SEEK_CODECS`). There the one pass decodes every
 * frame whatever it is told, and a 22-minute 4K AV1 file did not finish in the 30 minutes
 * allowed, twice. Seeking to the keyframe before each tile and decoding that one frame took
 * ~0.19 s a tile on the NAS — about twenty seconds for the same file — so those files seek.
 */

/**
 * A sprite render that takes longer than this has hit something pathological.
 *
 * Generous, because it is bounded by decode speed over the entire file rather than by seek
 * time: a three-hour 4K file on a slow NAS legitimately takes many minutes.
 */
const SPRITE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How far into the file to look when measuring keyframe spacing.
 *
 * Only packet headers are read, so this is cheap even over a share. A minute holds several
 * GOPs at any spacing that could pass `keyframesSuffice`, and encoders keep one cadence for a
 * whole file, so reading further would only confirm what the first minute already said.
 */
const KEYFRAME_SAMPLE_SECONDS = 60;

/** Measuring the spacing reads packet headers only; anything slower than this is a bad file. */
const KEYFRAME_PROBE_TIMEOUT_MS = 60 * 1000;

/**
 * Codecs whose decoder here ignores `-skip_frame nokey`, so the one-pass keyframe path decodes
 * every frame anyway (§9).
 *
 * AV1 is decoded by libdav1d, and the image's ffmpeg 5.1 does not pass "keyframes only" on to it.
 * On a 4K file that is every frame of the file at one thread: measured on the NAS, past the
 * 30-minute limit, twice, where seeking to each tile's keyframe took ~0.19 s a tile. Listed by
 * codec rather than measured per file, because the cost of finding out is the thirty minutes.
 */
const SEEK_CODECS: ReadonlySet<string> = new Set(["av1"]);

/** One tile by seeking: opening the file, finding the keyframe, decoding it. */
const SEEK_TILE_TIMEOUT_MS = 60 * 1000;

export interface RenderedSprites {
    /** Absolute paths of the sheets, in ordinal order. */
    sheetPaths: string[];
    /** Measured from the first sheet — the source aspect ratio decides the tile height. */
    tileWidth: number;
    tileHeight: number;
    /** Which decode path ran, so the choice can be asserted rather than trusted. */
    decode: "keyframes" | "full" | "seek";
}

/**
 * Render the sheets for one video into `outputDir`.
 *
 * ffmpeg writes `sprite-0.webp`, `sprite-1.webp`… directly, using the `image2` muxer's
 * numbering rather than our renaming them afterwards. The filter chain is the one from §9:
 * sample at a fixed rate, scale to a thumbnail, and pack into a 10x10 grid.
 *
 * With `-skip_frame nokey` the decoder discards everything but keyframes, and `fps` takes the
 * nearest one for each tile. Measured on a 10-minute 1080p file limited to two threads —
 * roughly what the NAS gives this job — that is 69s down to 10s, and unlike the full decode
 * the keyframe path does not slow down as cores are taken away.
 */
export const renderSpriteSheets = async (
    inputPath: string,
    outputDir: string,
    layout: SpriteLayout,
    /** For a test: take the seek path whatever the codec. */
    options: { seek?: boolean } = {}
): Promise<RenderedSprites> => {
    const ffmpeg = await resolveFfmpeg();

    await mkdir(outputDir, { recursive: true });

    // Remove any sheets from a previous run first. A shorter video regenerated over a longer
    // one would otherwise leave the surplus sheets behind, and the VTT would not reference
    // them — invisible files accumulating on a NAS until someone goes looking.
    await removeExistingSheets(outputDir);

    const seek = options.seek ?? SEEK_CODECS.has((await videoCodec(inputPath)) ?? "");
    const keyframesOnly = !seek && keyframesSuffice(await largestKeyframeGapMs(inputPath), layout);

    if (seek) {
        await renderBySeeking(ffmpeg, inputPath, outputDir, layout);
    } else {
        await runFfmpeg(ffmpeg, inputPath, outputDir, layout, keyframesOnly);
    }

    let sheetPaths = await listSheetPaths(outputDir);
    let decode: RenderedSprites["decode"] = seek ? "seek" : keyframesOnly ? "keyframes" : "full";

    /**
     * Nothing from the keyframe path is a reason to decode everything, not a failed job.
     *
     * Keyframe sampling is an optimisation, so when it produces nothing the honest answer is
     * the slow path rather than an error. `-reinit_filter 0` below is the known cause; this is
     * for whichever one is not known yet.
     */
    if (sheetPaths.length === 0 && keyframesOnly) {
        await runFfmpeg(ffmpeg, inputPath, outputDir, layout, false);
        sheetPaths = await listSheetPaths(outputDir);
        decode = "full";
    }

    if (sheetPaths.length === 0) {
        throw new Error("ffmpeg produced no sprite sheets");
    }

    // The tile size is measured, never assumed: `scale=200:-2` derives the height from the
    // source aspect ratio, and a VTT built on a guess points at the wrong rectangles.
    const { width, height } = await imageDimensions(sheetPaths[0]);

    if (!width || !height) {
        throw new Error("Could not measure the generated sprite sheet");
    }

    return {
        sheetPaths,
        tileWidth: Math.round(width / SPRITE_COLUMNS),
        tileHeight: Math.round(height / SPRITE_ROWS),
        decode,
    };
};

const listSheetPaths = async (outputDir: string): Promise<string[]> =>
    (await listSheets(outputDir)).map((name) => path.join(outputDir, name));

/** The first video stream's codec, as ffprobe names it, or null when it cannot be told. */
const videoCodec = async (inputPath: string): Promise<string | null> => {
    try {
        const ffprobe = await resolveFfprobe();
        const { stdout } = await execFileAsync(
            ffprobe,
            [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "csv=p=0",
                inputPath,
            ],
            { timeout: KEYFRAME_PROBE_TIMEOUT_MS }
        );

        return stdout.trim().split(/\r?\n/)[0] || null;
    } catch {
        return null;
    }
};

const exists = async (file: string): Promise<boolean> =>
    stat(file).then(
        () => true,
        () => false
    );

/**
 * The sheets by seeking (`SEEK_CODECS`): each tile is the keyframe at or before its time, read
 * on its own, then all of them packed into sheets by one more ffmpeg.
 *
 * `-noaccurate_seek` is the whole of it: without it ffmpeg decodes from the keyframe forward to
 * the exact time, which on the NAS was 5.4 s a tile against 0.19 s. A tile is then at most one
 * keyframe interval early — on the files measured, four seconds in fourteen. A tile that cannot
 * be read repeats its neighbour's picture rather than leaving a hole, because every later tile's
 * position on the sheet depends on the count.
 *
 * In a directory of this attempt's own, as previews are, so a killed attempt cannot leave tiles
 * for the next to mistake for its own; the orphan sweep takes an abandoned one.
 */
const renderBySeeking = async (
    ffmpeg: string,
    inputPath: string,
    outputDir: string,
    layout: SpriteLayout
): Promise<void> => {
    const workDir = await mkdtemp(path.join(outputDir, ".sprite-tiles-"));
    const tile = (index: number): string =>
        path.join(workDir, `tile-${String(index).padStart(5, "0")}.png`);

    try {
        const missing: number[] = [];
        let read: number | null = null;

        for (let index = 0; index < layout.tileCount; index += 1) {
            try {
                await runPolitely(
                    ffmpeg,
                    capThreads([
                        "-v",
                        "error",
                        "-y",
                        "-ss",
                        ((index * layout.intervalMs) / 1000).toFixed(3),
                        "-noaccurate_seek",
                        "-i",
                        inputPath,
                        "-an",
                        "-sn",
                        "-frames:v",
                        "1",
                        "-vf",
                        `scale=${SPRITE_TILE_WIDTH}:-2:flags=lanczos`,
                        tile(index),
                    ]),
                    { timeoutMs: SEEK_TILE_TIMEOUT_MS }
                );
            } catch {
                // Left to the gap-filling below: one unreadable moment is not a failed sheet.
            }

            if (await exists(tile(index))) {
                read = index;
            } else if (read !== null) {
                await copyFile(tile(read), tile(index));
            } else {
                missing.push(index);
            }
        }

        if (read === null) {
            throw new Error("No frame could be read by seeking");
        }

        // Leading tiles nothing could be read for take the first picture that could, which is
        // the one after them: a gap after it already repeated its neighbour.
        for (const index of missing) {
            await copyFile(tile(missing.length), tile(index));
        }

        await runPolitely(
            ffmpeg,
            capThreads([
                "-v",
                "error",
                "-y",
                "-framerate",
                "1",
                "-start_number",
                "0",
                "-i",
                path.join(workDir, "tile-%05d.png"),
                "-vf",
                `tile=${SPRITE_COLUMNS}x${SPRITE_ROWS}`,
                ...sheetOutput(outputDir),
            ]),
            { timeoutMs: SPRITE_TIMEOUT_MS }
        );
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
};

const runFfmpeg = (
    ffmpeg: string,
    inputPath: string,
    outputDir: string,
    layout: SpriteLayout,
    keyframesOnly: boolean
): Promise<void> => {
    // `fps=1/N` resamples the timeline rather than selecting frames, so the output is exactly
    // one frame per interval regardless of the source frame rate or of dropped frames.
    const interval = (layout.intervalMs / 1000).toFixed(3);
    const filters = [
        `fps=1/${interval}`,
        `scale=${SPRITE_TILE_WIDTH}:-2:flags=lanczos`,
        `tile=${SPRITE_COLUMNS}x${SPRITE_ROWS}`,
    ].join(",");

    return runPolitely(
        ffmpeg,
        capThreads([
            "-v",
            "error",
            "-y",
            /**
             * Never fail for decode errors: a damaged stretch gets tiles, not a missing strip.
             *
             * ffmpeg carries on past packets it cannot decode, then exits 69 at the end if more
             * than the default 2/3 of them failed, after the sheets are already written.
             * Measured with the image's ffmpeg 5.1 on an H.264 file with 80% of its bytes
             * overwritten -- and in production that exit settled the item as unreadable, with
             * its sheets sitting on disk.
             */
            "-max_error_rate",
            "1",
            // An input option, so it must precede `-i`: it tells the decoder what to skip.
            ...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
            /**
             * Keep one filter graph for the whole file.
             *
             * By default ffmpeg rebuilds the graph whenever a decoded frame's format changes,
             * and the rebuild discards whatever `tile` had collected towards the sheet in
             * progress. A file spliced from clips with different colour metadata -- yuvj420p
             * full range beside yuv420p bt709, measured in production -- changes format at
             * every join: tiles went missing, and on the keyframe path a five-minute video
             * produced no sheet at all. `scale` adapts to a new input size by itself, so
             * nothing downstream needs the rebuild.
             */
            "-reinit_filter",
            "0",
            "-i",
            inputPath,
            "-an",
            "-sn",
            "-vf",
            filters,
            ...sheetOutput(outputDir),
        ]),
        { timeoutMs: SPRITE_TIMEOUT_MS }
    );
};

/** How a sheet is written, whichever way its tiles were read. */
const sheetOutput = (outputDir: string): string[] => [
    /**
     * 70 rather than the 78 this started at, measured on a real sheet: ~11% smaller
     * for an SSIM of 0.985 against 0.990.
     *
     * These thumbnails get the most forgiving viewing condition in the app — 200px
     * wide, shown for a fraction of a second under a moving pointer, never studied.
     * Cover art is the opposite and keeps its own quality.
     */
    "-q:v",
    "70",
    /**
     * Maximum encoder effort: ~6% smaller at the same quality, for ~160ms per sheet.
     *
     * Free in context. Even the keyframe path spends seconds decoding, where encoding
     * a whole sheet measures ~0.4s; and unlike the quality setting this costs nothing
     * in fidelity.
     */
    "-compression_level",
    "6",
    /**
     * Force the *still* WebP encoder and the image sequence muxer.
     *
     * Without both, a `.webp` output selects ffmpeg's animation path: every sheet is
     * packed into one file as ANMF frames, `%d` never expands, and what comes out is
     * a single animated image that ffmpeg's own decoder then refuses to read
     * ("image data not found"). The browser would have shown a slideshow where the
     * scrubber expected a grid.
     */
    "-c:v",
    "libwebp",
    "-f",
    "image2",
    // Without this the first sheet is sprite-1, and every ordinal is off by one
    // against the database and the VTT.
    "-start_number",
    "0",
    path.join(outputDir, "sprite-%d.webp"),
];

/**
 * Whether sampling only keyframes still gives every tile its own frame.
 *
 * On that path a tile can only be a keyframe, so keyframes further apart than the sampling
 * interval would repeat a picture across consecutive tiles — a scrubber that holds still
 * while the pointer moves. At or under the interval every tile gets a distinct frame, at most
 * half a GOP from its nominal time, which at 2–30s intervals is finer than a thumbnail under
 * a moving pointer can show.
 *
 * Phone and screen recordings place keyframes every second or two and pass easily. The files
 * that fail are long-GOP encodes — x264's default allows ten seconds — and those take the full
 * decode rather than a degraded sheet. So does a file whose spacing could not be measured:
 * slower, never wrong.
 */
const keyframesSuffice = (gapMs: number | null, layout: SpriteLayout): boolean =>
    gapMs !== null && gapMs <= layout.intervalMs;

/**
 * The widest spacing between keyframes in the first minute of the video stream, or null when
 * it cannot be told.
 *
 * Reads packet flags rather than decoding, so it costs a fraction of a second. The run from
 * the last keyframe to the last packet read counts too: it is a lower bound on that GOP, and
 * it is what catches a GOP too long for the window. Fewer than two keyframes is null for the
 * same reason — one keyframe says nothing about spacing, and a minute without a second one is
 * exactly the file the full decode exists for.
 *
 * Exported as a test seam.
 */
export const largestKeyframeGapMs = async (inputPath: string): Promise<number | null> => {
    try {
        const ffprobe = await resolveFfprobe();
        const { stdout } = await execFileAsync(
            ffprobe,
            [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-read_intervals",
                `%+${KEYFRAME_SAMPLE_SECONDS}`,
                "-show_entries",
                "packet=pts_time,dts_time,flags",
                "-of",
                "csv=p=0",
                inputPath,
            ],
            { timeout: KEYFRAME_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
        );

        const keyframes: number[] = [];
        let lastPacket = -Infinity;

        for (const line of stdout.split(/\r?\n/)) {
            // `pts_time,dts_time,flags` — pts is N/A in some containers, where dts stands in.
            const [pts, dts, flags] = line.split(",");
            const seconds = Number(pts === "N/A" ? dts : pts);

            if (!Number.isFinite(seconds)) {
                continue;
            }

            lastPacket = Math.max(lastPacket, seconds);

            if (flags?.startsWith("K")) {
                keyframes.push(seconds);
            }
        }

        if (keyframes.length < 2) {
            return null;
        }

        // Packets arrive in decode order, which is not presentation order once B-frames are
        // involved, so the keyframes are sorted before the gaps between them are measured.
        keyframes.sort((a, b) => a - b);

        let largest = lastPacket - keyframes[keyframes.length - 1];

        for (let i = 1; i < keyframes.length; i++) {
            largest = Math.max(largest, keyframes[i] - keyframes[i - 1]);
        }

        return Math.round(largest * 1000);
    } catch {
        // Measuring is an optimisation. A file ffprobe cannot read this way still gets its
        // sheets the slow way — and if ffmpeg cannot read it either, that is the error worth
        // reporting.
        return null;
    }
};

/**
 * Sheet file names in ordinal order.
 *
 * Sorted numerically rather than lexicographically, which matters as soon as there are more
 * than ten: `sprite-10` sorts before `sprite-2` as text, and the sheets would be recorded
 * against the wrong ordinals.
 */
const listSheets = async (outputDir: string): Promise<string[]> => {
    const entries = await readdir(outputDir);

    return entries
        .filter((name) => /^sprite-\d+\.webp$/.test(name))
        .sort((a, b) => sheetOrdinal(a) - sheetOrdinal(b));
};

const sheetOrdinal = (name: string): number => Number(/^sprite-(\d+)\.webp$/.exec(name)?.[1] ?? 0);

const removeExistingSheets = async (outputDir: string): Promise<void> => {
    for (const name of await listSheets(outputDir)) {
        await rm(path.join(outputDir, name), { force: true });
    }
};
