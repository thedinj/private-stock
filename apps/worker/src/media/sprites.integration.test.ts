import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    SPRITE_COLUMNS,
    SPRITE_ROWS,
    TILES_PER_SHEET,
    buildSpriteVtt,
    parseSpriteVtt,
    spriteLayout,
} from "@private-stock/core";

import { resolveFfmpeg, resolveFfprobe } from "./binaries.js";
import { previewOffsets, renderPreview } from "./clips.js";
import { imageDimensions } from "./frames.js";
import { largestKeyframeGapMs, renderSpriteSheets } from "./sprites.js";

const execFileAsync = promisify(execFile);

/**
 * Sprite sheets and previews, against real ffmpeg.
 *
 * These exist because of a bug no unit test could have caught: writing sheets to `.webp`
 * selects ffmpeg's *animation* encoder, so all the sheets were packed into one file as ANMF
 * frames, `%d` never expanded, and the result was an animated image that ffmpeg's own decoder
 * then refused to read. Everything about the code looked right.
 */

let workDir: string;

/** Four minutes — enough frames to fill more than one sheet at `MULTI_SHEET`'s interval. */
const LONG = "long.mp4";
/** Too short to sample six segments from. */
const TINY = "tiny.mp4";
/** A keyframe every second — a phone or screen recording, and the keyframe path's case. */
const SHORT_GOP = "gop-1s.mp4";
/** A keyframe every ten seconds — x264's default ceiling, and the full decode's case. */
const LONG_GOP = "gop-10s.mp4";

/**
 * A layout that spans two sheets, written out rather than derived from `spriteLayout`.
 *
 * `spriteLayout` now fits any video under 50 minutes into one sheet, and a fixture that long
 * would take minutes to generate and decode for every run. Stating the layout instead tests
 * what this file is for — that the renderer writes separate, readable sheets — and keeps that
 * coverage from quietly lapsing the next time the calibration constants move.
 */
const MULTI_SHEET = {
    intervalMs: 1_000,
    tileCount: 240,
    sheetCount: Math.ceil(240 / TILES_PER_SHEET),
    columns: SPRITE_COLUMNS,
    rows: SPRITE_ROWS,
};

beforeAll(async () => {
    const ffmpeg = await resolveFfmpeg();
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-sprites-"));

    await execFileAsync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=320x180:r=10:d=240",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, LONG),
    ]);

    await execFileAsync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=320x180:r=10:d=1",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, TINY),
    ]);

    // Fixed GOPs, scene-cut detection off so the encoder cannot add keyframes of its own.
    for (const [name, gop] of [
        [SHORT_GOP, "10"],
        [LONG_GOP, "100"],
    ]) {
        await execFileAsync(ffmpeg, [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=s=320x180:r=10:d=60",
            "-pix_fmt",
            "yuv420p",
            "-g",
            gop,
            "-keyint_min",
            gop,
            "-sc_threshold",
            "0",
            path.join(workDir, name),
        ]);
    }
}, 180_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("renderSpriteSheets", () => {
    it("writes separate, readable still images rather than one animation", async () => {
        const outputDir = path.join(workDir, "sheets");

        const rendered = await renderSpriteSheets(path.join(workDir, LONG), outputDir, MULTI_SHEET);

        // More than one sheet is the case that exposed the animation bug.
        expect(rendered.sheetPaths.length).toBeGreaterThan(1);

        for (const sheet of rendered.sheetPaths) {
            const { width, height } = await imageDimensions(sheet);

            // An animated WebP measures as nothing here: "image data not found".
            expect(width).toBeGreaterThan(0);
            expect(height).toBeGreaterThan(0);
        }
    });

    it("measures the tile size from the sheet rather than assuming it", async () => {
        const outputDir = path.join(workDir, "measured");
        const rendered = await renderSpriteSheets(
            path.join(workDir, LONG),
            outputDir,
            spriteLayout(240_000)
        );

        // 320x180 source scaled to 200 wide is 200x112 (rounded to an even height).
        expect(rendered.tileWidth).toBe(200);
        expect(rendered.tileHeight).toBe(112);

        const { width } = await imageDimensions(rendered.sheetPaths[0]);
        expect(width).toBe(rendered.tileWidth * SPRITE_COLUMNS);
    });

    it("clears surplus sheets from a previous, longer render", async () => {
        const outputDir = path.join(workDir, "surplus");

        await renderSpriteSheets(path.join(workDir, LONG), outputDir, spriteLayout(240_000));

        // A stray sheet from an earlier run that the new one does not overwrite. Left behind,
        // it is invisible: nothing references it and it never expires.
        await writeFile(path.join(outputDir, "sprite-9.webp"), "stale");

        const rendered = await renderSpriteSheets(
            path.join(workDir, LONG),
            outputDir,
            spriteLayout(240_000)
        );

        expect(rendered.sheetPaths.some((sheet) => sheet.endsWith("sprite-9.webp"))).toBe(false);
    });

    it("produces a VTT whose cues address real rectangles inside the sheets", async () => {
        const outputDir = path.join(workDir, "vtt");
        const layout = MULTI_SHEET;
        const rendered = await renderSpriteSheets(path.join(workDir, LONG), outputDir, layout);

        const vtt = buildSpriteVtt({
            layout,
            durationMs: 240_000,
            tileWidth: rendered.tileWidth,
            tileHeight: rendered.tileHeight,
            sheetUrl: (ordinal) => `/api/art/x/sprite-${ordinal}`,
        });

        const cues = parseSpriteVtt(vtt);
        const sheetSize = await imageDimensions(rendered.sheetPaths[0]);

        expect(cues.length).toBeGreaterThan(TILES_PER_SHEET);

        for (const cue of cues) {
            // Every rectangle must lie inside the sheet it names — an off-by-one in the
            // layout shows up as a blank or half-shifted thumbnail, not as an error.
            expect(cue.x + cue.width).toBeLessThanOrEqual(sheetSize.width!);
            expect(cue.y + cue.height).toBeLessThanOrEqual(sheetSize.height!);
        }
    });
});

describe("keyframe-only decoding", () => {
    it("measures the spacing between keyframes", async () => {
        expect(await largestKeyframeGapMs(path.join(workDir, SHORT_GOP))).toBe(1_000);
        expect(await largestKeyframeGapMs(path.join(workDir, LONG_GOP))).toBe(10_000);
    });

    it("reports nothing rather than guessing for a file it cannot read", async () => {
        const notVideo = path.join(workDir, "not-video.mp4");
        await writeFile(notVideo, "not a video");

        expect(await largestKeyframeGapMs(notVideo)).toBeNull();
    });

    it("decodes only keyframes when they are at least as dense as the tiles", async () => {
        // 60s gives the 2s minimum interval, against a keyframe every second.
        const rendered = await renderSpriteSheets(
            path.join(workDir, SHORT_GOP),
            path.join(workDir, "short-gop"),
            spriteLayout(60_000)
        );

        expect(rendered.decode).toBe("keyframes");
        expect(rendered.sheetPaths).toHaveLength(1);
        expect(rendered.tileWidth).toBe(200);
    });

    /**
     * The path for decoders that ignore "keyframes only" — AV1 here (§9). Forced on an H.264
     * fixture, because the encoders a test can count on do not include AV1; what it pins is
     * that seeking makes the same sheets the other paths do, and cleans up after itself.
     */
    it("makes the same sheets by seeking to each tile's keyframe", async () => {
        const outputDir = path.join(workDir, "seeking");
        const layout = spriteLayout(60_000);
        const rendered = await renderSpriteSheets(
            path.join(workDir, SHORT_GOP),
            outputDir,
            layout,
            {
                seek: true,
            }
        );

        expect(rendered.decode).toBe("seek");
        expect(rendered.sheetPaths).toHaveLength(1);
        expect(rendered.tileWidth).toBe(200);
        expect(rendered.tileHeight).toBe(112);

        const { width, height } = await imageDimensions(rendered.sheetPaths[0]);

        expect(width).toBe(200 * SPRITE_COLUMNS);
        expect(height).toBe(112 * SPRITE_ROWS);
        // Its scratch tiles are gone; only the sheet is left.
        expect((await readdir(outputDir)).filter((name) => name.startsWith("."))).toEqual([]);
    });

    it("decodes every frame when keyframes are sparser than the tiles", async () => {
        // Keyframe-only here would repeat each picture across five consecutive tiles.
        const rendered = await renderSpriteSheets(
            path.join(workDir, LONG_GOP),
            path.join(workDir, "long-gop"),
            spriteLayout(60_000)
        );

        expect(rendered.decode).toBe("full");
        expect(rendered.sheetPaths).toHaveLength(1);
    });

    /**
     * A file spliced from clips with different colour metadata, as found in production: a
     * full-range yuvj420p stretch beside a yuv420p bt709 one.
     *
     * ffmpeg rebuilt the filter graph at every join and the rebuild threw away the tiles
     * collected so far, so sheets silently lost their beginning -- and on the keyframe path a
     * five-minute video produced no sheet at all. The first stretch is red and the second
     * blue, so a sheet that starts blue is one that lost its start.
     */
    it("keeps the tiles collected before a change of pixel format", async () => {
        const ffmpeg = await resolveFfmpeg();
        const segments = [
            ["red", "yuvj420p", "pc", "bt470bg"],
            ["blue", "yuv420p", "tv", "bt709"],
        ];
        const parts: Buffer[] = [];

        for (const [colour, pixFmt, range, space] of segments) {
            const part = path.join(workDir, `splice-${colour}.ts`);

            await execFileAsync(ffmpeg, [
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                `color=c=${colour}:s=320x180:r=10:d=30`,
                "-c:v",
                "libx264",
                "-pix_fmt",
                pixFmt,
                "-color_range",
                range,
                "-colorspace",
                space,
                "-g",
                "10",
                "-keyint_min",
                "10",
                "-sc_threshold",
                "0",
                part,
            ]);
            parts.push(await readFile(part));
        }

        // MPEG-TS concatenates byte for byte, which is how a splice keeps both formats.
        const spliced = path.join(workDir, "spliced.ts");
        await writeFile(spliced, Buffer.concat(parts));

        const rendered = await renderSpriteSheets(
            spliced,
            path.join(workDir, "spliced"),
            spriteLayout(60_000)
        );

        expect(rendered.decode).toBe("keyframes");
        expect(rendered.sheetPaths).toHaveLength(1);

        const { stdout } = await execFileAsync(
            ffmpeg,
            [
                "-v",
                "error",
                "-i",
                rendered.sheetPaths[0],
                "-vf",
                "crop=20:20:40:40,scale=1:1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ],
            { encoding: "buffer" }
        );
        const [red, , blue] = stdout;

        expect(red).toBeGreaterThan(180);
        expect(blue).toBeLessThan(80);
    });
});

describe("renderPreview", () => {
    it("joins the segments into one playable silent clip", async () => {
        const outputPath = path.join(workDir, "preview.webm");

        expect(await renderPreview(path.join(workDir, LONG), outputPath, 240_000)).toBe(true);

        const { stdout } = await execFileAsync(await resolveFfprobe(), [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            outputPath,
        ]);

        const probed = JSON.parse(stdout) as {
            streams: { codec_type: string }[];
            format: { duration: string };
        };

        // Six one-second segments, give or take the encoder's frame alignment.
        expect(Number(probed.format.duration)).toBeGreaterThan(3);
        expect(Number(probed.format.duration)).toBeLessThan(9);

        // Silent by design: a grid of tiles that all start talking at once is the reason
        // autoplay policies exist.
        expect(probed.streams.every((stream) => stream.codec_type === "video")).toBe(true);
    });

    it("leaves no working files inside the artifact directory", async () => {
        const dir = path.join(workDir, "clean");
        await mkdir(dir, { recursive: true });

        await renderPreview(path.join(workDir, LONG), path.join(dir, "preview.webm"), 240_000);

        // The parts directory sits inside what the web app serves from; surviving it would be
        // both clutter and a slow leak.
        expect(await readdir(dir)).toEqual(["preview.webm"]);
    });

    it("still produces something for a clip too short to sample six times", async () => {
        const outputPath = path.join(workDir, "tiny-preview.webm");

        expect(previewOffsets(1_000).length).toBeLessThan(6);
        expect(await renderPreview(path.join(workDir, TINY), outputPath, 1_000)).toBe(true);
        expect(await readFile(outputPath)).not.toHaveLength(0);
    });

    it("reports failure rather than writing a broken file when there is no duration", async () => {
        // A missing preview is a tile that does not animate; a corrupt one is a broken tile.
        expect(
            await renderPreview(path.join(workDir, LONG), path.join(workDir, "none.webm"), null)
        ).toBe(false);
    });
});
