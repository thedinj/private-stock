import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "@private-stock/core/server";

import { FACE_DETECTOR, FACE_RECOGNISER } from "../jobs/faces.js";
import { embedInChild, facesInChild, stopModelChild } from "./embedder.js";

/**
 * The faces half of the model child end to end (§5f): real ffmpeg, the real models, a real child
 * process.
 *
 * Fixtures are generated, never library content — so they hold no faces, and what this pins
 * down is the plumbing: both models load and answer for tiles of either shape, every region
 * asked about is read, and a picture with nobody in it writes nothing. How well faces are found
 * and told apart was the bake-off's question, answered on the library itself (§5f).
 */

let dir: string;
let ffmpeg: string;

const render = (file: string, size: string): void => {
    execFileSync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${size}`,
        "-frames:v",
        "1",
        file,
    ]);
};

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ps-faces-"));
    ffmpeg = await resolveFfmpeg();
});

afterAll(() => {
    stopModelChild();
    rmSync(dir, { recursive: true, force: true });
});

describe("the faces child", () => {
    it("reads every region of wide and upright pictures, and writes nothing without a face", async () => {
        const wide = path.join(dir, "wide.png");
        const upright = path.join(dir, "upright.png");
        const outPath = path.join(dir, "none.vec");

        render(wide, "400x112");
        render(upright, "200x356");

        const result = await facesInChild({
            detector: FACE_DETECTOR,
            recogniser: FACE_RECOGNISER,
            stageVersion: 1,
            threads: 2,
            sources: [
                {
                    absolutePath: wide,
                    width: 400,
                    height: 112,
                    regions: [
                        { rect: { x: 0, y: 0, width: 200, height: 112 }, atMs: 0 },
                        { rect: { x: 200, y: 0, width: 200, height: 112 }, atMs: 4000 },
                    ],
                },
                {
                    absolutePath: upright,
                    width: 200,
                    height: 356,
                    regions: [{ rect: { x: 0, y: 0, width: 200, height: 356 }, atMs: null }],
                },
            ],
            outPath,
        });

        expect(result.regions).toBe(3);
        expect(result.faces).toEqual([]);
        expect(existsSync(outPath)).toBe(false);
    });

    it("hands the child to the other family and back without losing a request", async () => {
        const picture = path.join(dir, "switch.png");

        render(picture, "224x224");

        const embedded = await embedInChild({
            model: "clip-b32-vision-uint8",
            stageVersion: 1,
            threads: 2,
            sources: [
                {
                    absolutePath: picture,
                    width: 224,
                    height: 224,
                    moments: [{ rect: { x: 0, y: 0, width: 224, height: 224 }, atMs: null }],
                },
            ],
            outPath: path.join(dir, "switch.vec"),
        });

        expect(embedded.vectors).toBe(1);
    });
});
