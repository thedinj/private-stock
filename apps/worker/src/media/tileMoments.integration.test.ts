import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SPRITE_COLUMNS, SPRITE_ROWS, TILES_PER_SHEET } from "@private-stock/core";
import { readTileMoments } from "@private-stock/core/server";

import { resolveFfmpeg } from "./binaries.js";
import { renderSpriteSheets } from "./sprites.js";

const execFileAsync = promisify(execFile);

/**
 * Finding the frame a sprite tile really is (§9 "What a tile shows"), against the sprites this
 * worker renders.
 *
 * Each frame of the fixture is one flat grey, a shade lighter each frame, so a frame is told by
 * its shade and the answer is checked against the frame each path is known to sample. The tiles
 * are half an interval late on the `fps` paths and up to a keyframe early when seeking; a face
 * found on one and framed at its nominal moment was a different picture.
 */

let workDir: string;

/** A keyframe every second: the keyframe path's case, and the seeking path's when made to. */
const SHORT_GOP = "gop-1s.mp4";
/** A keyframe every ten seconds, past the interval: the full decode's case. */
const LONG_GOP = "gop-10s.mp4";

/** Stated rather than derived, so the tiles are far enough apart to tell each path's frame. */
const LAYOUT = {
    intervalMs: 6_000,
    tileCount: 4,
    sheetCount: 1,
    columns: SPRITE_COLUMNS,
    rows: SPRITE_ROWS,
};

const FRAME_MS = 100;

const makeFixture = async (name: string, gopFrames: number): Promise<void> => {
    await execFileAsync(await resolveFfmpeg(), [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        // Ten frames a second for 24 seconds: 240 frames, each its own shade.
        "color=c=black:s=320x180:r=10:d=24,format=gray,geq=lum='N'",
        "-c:v",
        "libx264",
        "-g",
        String(gopFrames),
        "-keyint_min",
        String(gopFrames),
        "-sc_threshold",
        "0",
        "-qp",
        "0",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, name),
    ]);
};

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-tile-moments-"));
    await makeFixture(SHORT_GOP, 10);
    await makeFixture(LONG_GOP, 100);
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

/** Render a fixture's sheets one way, then ask what each tile is. */
const tileMomentsOf = async (
    fixture: string,
    options: { seek?: boolean }
): Promise<{ decode: string; matched: (number | null)[] }> => {
    const original = path.join(workDir, fixture);
    const outputDir = path.join(workDir, `${fixture}-${options.seek ? "seek" : "pass"}`);

    await mkdir(outputDir, { recursive: true });

    const rendered = await renderSpriteSheets(original, outputDir, LAYOUT, options);
    const matched: (number | null)[] = [];

    for (let index = 1; index < LAYOUT.tileCount; index += 1) {
        const within = index % TILES_PER_SHEET;
        const read = await readTileMoments({
            original,
            atMs: index * LAYOUT.intervalMs,
            intervalMs: LAYOUT.intervalMs,
            tile: {
                sheetPath: rendered.sheetPaths[0],
                rect: {
                    x: (within % SPRITE_COLUMNS) * rendered.tileWidth,
                    y: Math.floor(within / SPRITE_COLUMNS) * rendered.tileHeight,
                    width: rendered.tileWidth,
                    height: rendered.tileHeight,
                },
            },
        });

        matched.push(read.matched === null ? null : read.moments[read.matched].atMs);
    }

    return { decode: rendered.decode, matched };
};

describe("readTileMoments", () => {
    it("finds the keyframe the keyframe path took: the last before half an interval on", async () => {
        const { decode, matched } = await tileMomentsOf(SHORT_GOP, {});

        expect(decode).toBe("keyframes");
        // Tiles at 6s, 12s and 18s: the keyframes at 8s, 14s and 20s.
        expect(matched).toEqual([8_000, 14_000, 20_000]);
    });

    it("finds the frame the full decode took: the last before half an interval on", async () => {
        const { decode, matched } = await tileMomentsOf(LONG_GOP, {});

        expect(decode).toBe("full");
        expect(matched).toEqual([9_000 - FRAME_MS, 15_000 - FRAME_MS, 21_000 - FRAME_MS]);
    });

    /**
     * Which frame `-noaccurate_seek` hands back depends on the ffmpeg. The image's 5.1 gives the
     * keyframe at or before the moment, which is what made seeking cheap on the NAS; 6.1, on
     * this fixture, gives a frame or two short of the moment itself. Either is a candidate, so
     * either is what the tile must be matched to.
     */
    it("finds the frame the seeking path took, whichever ffmpeg took it", async () => {
        const { decode, matched } = await tileMomentsOf(LONG_GOP, { seek: true });
        const keyframeBefore = [0, 10_000, 10_000];
        const moment = [6_000, 12_000, 18_000];

        expect(decode).toBe("seek");
        matched.forEach((atMs, index) => {
            expect([keyframeBefore[index], moment[index]]).toContain(atMs);
        });
    });
});
