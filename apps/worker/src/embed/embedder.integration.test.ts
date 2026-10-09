import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeVectorFile, type Rect } from "@private-stock/core";
import { resolveFfmpeg } from "@private-stock/core/server";

import { embedInChild, stopModelChild } from "./embedder.js";
import type { EmbedSource } from "./protocol.js";

/**
 * The embedder child end to end (§5e): real ffmpeg, the real model, a real child process.
 *
 * Fixtures are generated, never library content. A sheet is laid out exactly as the sprite stage
 * lays one out — a 10×10 grid of tiles, padded when there are fewer than 100 — because reading a
 * short video's sheet with the wrong tile height is the bug that cost the bake-off a re-run.
 */

const MODEL = "clip-b32-vision-uint8";
const TILE = { width: 200, height: 356 };
const INTERVAL_MS = 5_000;

let dir: string;
let ffmpeg: string;

const render = (args: string[]): void => {
    execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
};

/** A sheet of `count` vertical tiles from a moving test pattern, padded to the full grid. */
const sheetSource = (file: string, count: number, pattern: string): EmbedSource => {
    render([
        "-f",
        "lavfi",
        "-i",
        `${pattern}${pattern.includes("=") ? ":" : "="}size=${TILE.width}x${TILE.height}:rate=1:duration=${count}`,
        "-vf",
        "tile=10x10",
        "-frames:v",
        "1",
        file,
    ]);

    return {
        absolutePath: file,
        width: TILE.width * 10,
        height: TILE.height * 10,
        moments: Array.from({ length: count }, (_, index) => ({
            rect: {
                x: (index % 10) * TILE.width,
                y: Math.floor(index / 10) * TILE.height,
                width: TILE.width,
                height: TILE.height,
            } satisfies Rect,
            atMs: index * INTERVAL_MS,
        })),
    };
};

const request = (sources: EmbedSource[], name: string) => ({
    model: MODEL,
    stageVersion: 1,
    threads: 2,
    sources,
    outPath: path.join(dir, `${name}.vec`),
});

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ps-embed-"));
    ffmpeg = await resolveFfmpeg();
});

afterAll(() => {
    stopModelChild();
    rmSync(dir, { recursive: true, force: true });
});

describe("the embedder child", () => {
    it("embeds every moment of a short video's sheet as two squares, and thins nothing new", async () => {
        const source = sheetSource(path.join(dir, "moving.webp"), 37, "testsrc2");
        const result = await embedInChild(request([source], "moving"));
        const file = decodeVectorFile(new Uint8Array(readFileSync(path.join(dir, "moving.vec"))));

        expect(result.moments).toBe(37);
        expect(result.kept).toBeGreaterThan(0);
        expect(result.kept).toBeLessThanOrEqual(37);
        // Vertical tiles are seen as a top and a bottom square.
        expect(result.vectors).toBe(result.kept * 2);
        expect(file.vectors).toHaveLength(result.vectors);
        expect(file.dims).toBe(512);
        expect(new Set(file.vectors.map((entry) => entry.square))).toEqual(new Set([0, 1]));
        expect(file.vectors.every((entry) => (entry.atMs ?? -1) % INTERVAL_MS === 0)).toBe(true);
        expect(file.vectors.every((entry) => (entry.atMs ?? 0) < 37 * INTERVAL_MS)).toBe(true);
        expect(file.representatives.length).toBeGreaterThan(0);
        expect(file.representatives.length).toBeLessThanOrEqual(8);
        expect(file.representatives.every((index) => index < file.vectors.length)).toBe(true);
    });

    it("keeps one moment of a picture that never changes", async () => {
        const source = sheetSource(path.join(dir, "still.webp"), 20, "color=c=0x336699");
        const result = await embedInChild(request([source], "still"));

        expect(result).toEqual({ moments: 20, kept: 1, vectors: 2 });
    });

    it("embeds a photograph's cover as one moment with no time", async () => {
        const cover = path.join(dir, "cover.webp");

        render(["-f", "lavfi", "-i", "testsrc2=size=640x854", "-frames:v", "1", cover]);

        const result = await embedInChild(
            request(
                [
                    {
                        absolutePath: cover,
                        width: 640,
                        height: 854,
                        moments: [{ rect: { x: 0, y: 0, width: 640, height: 854 }, atMs: null }],
                    },
                ],
                "photo"
            )
        );
        const file = decodeVectorFile(new Uint8Array(readFileSync(path.join(dir, "photo.vec"))));

        expect(result).toEqual({ moments: 1, kept: 1, vectors: 2 });
        expect(file.vectors.every((entry) => entry.atMs === null)).toBe(true);
    });

    it("fails a request whose picture is not the size it was said to be, and keeps serving", async () => {
        const source = sheetSource(path.join(dir, "wrong.webp"), 5, "testsrc2");

        await expect(embedInChild(request([{ ...source, height: 999 }], "wrong"))).rejects.toThrow(
            /decoded to/
        );

        const again = await embedInChild(request([source], "right"));

        expect(again.moments).toBe(5);
    });
});
