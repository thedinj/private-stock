import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    alignTilePrints,
    prepareTilePrints,
    spriteLayout,
    tilesMatch,
    type PreparedTilePrints,
} from "@private-stock/core";

import { resolveFfmpeg } from "../media/binaries.js";
import { renderSpriteSheets } from "../media/sprites.js";

import { printSheet } from "./tilePrint.js";

const execFileAsync = promisify(execFile);

/**
 * Tile prints from sprite sheets ffmpeg really drew (§10h).
 *
 * The case that motivated them: one video, and a copy of it re-encoded smaller with a second
 * and a half less lead-in. The perceptual hash samples the two at different moments; the
 * sprite grid is the same for both, so the tiles should still line up. A different video of
 * the same length is the control.
 */

let workDir: string;

const ORIGINAL = "original.mp4";
const LATE = "late.mp4";
const OTHER = "other.mp4";
const DURATION_MS = 60_000;

const encode = async (args: string[]): Promise<void> => {
    await execFileAsync(await resolveFfmpeg(), ["-v", "error", "-y", ...args]);
};

/** A video's prints, through the same sprite renderer and sheet reader production uses. */
const printsOf = async (name: string, durationMs: number): Promise<PreparedTilePrints> => {
    const layout = spriteLayout(durationMs);
    const rendered = await renderSpriteSheets(
        path.join(workDir, name),
        path.join(workDir, `${name}-sprites`),
        layout
    );
    const tiles = [];

    for (const [ordinal, sheet] of rendered.sheetPaths.entries()) {
        const remaining = layout.tileCount - ordinal * layout.columns * layout.rows;

        tiles.push(...(await printSheet(sheet, Math.min(remaining, layout.columns * layout.rows))));
    }

    return prepareTilePrints({ intervalMs: layout.intervalMs, tiles });
};

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "ps-tileprint-"));

    // Moving footage in five-second shots, each its own colour, so that what a tile shows
    // depends on when it was taken.
    await encode([
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=320x180:r=10:d=${DURATION_MS / 1000 + 2},hue=H=2*PI*floor(t/5)/7`,
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, ORIGINAL),
    ]);
    await encode([
        "-ss",
        "1.5",
        "-i",
        path.join(workDir, ORIGINAL),
        "-vf",
        "scale=256:144",
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, LATE),
    ]);
    await encode([
        "-f",
        "lavfi",
        "-i",
        `mandelbrot=s=320x180:r=10`,
        "-t",
        String(DURATION_MS / 1000 + 2),
        "-pix_fmt",
        "yuv420p",
        path.join(workDir, OTHER),
    ]);
}, 120_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("tile prints", () => {
    it("line up a smaller copy that starts a second and a half later", async () => {
        const original = await printsOf(ORIGINAL, DURATION_MS + 2_000);
        const late = await printsOf(LATE, DURATION_MS + 500);

        expect(original.tiles.some((tile) => tile !== null)).toBe(true);
        expect(tilesMatch(alignTilePrints(original, late), 3)).toBe(true);
    }, 120_000);

    it("do not line up a different video of the same length", async () => {
        const original = await printsOf(ORIGINAL, DURATION_MS + 2_000);
        const other = await printsOf(OTHER, DURATION_MS + 2_000);

        expect(tilesMatch(alignTilePrints(original, other), 3)).toBe(false);
    }, 120_000);
});
