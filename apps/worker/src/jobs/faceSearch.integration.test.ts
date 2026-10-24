import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "@private-stock/core/server";

import { stopModelChild } from "../embed/embedder.js";
import { searchFrame } from "./faceSearch.js";

/**
 * "Who is this?" end to end as far as a generated video allows (§5f): real ffmpeg pulling the frame
 * at a moment out of a real file, the real models reading it. Fixtures are generated, never
 * library content — so they hold no faces, and what this pins down is the plumbing: the frame is
 * found at the moment asked, read, and the scratch files it made are gone afterwards.
 */

let dir: string;
let video: string;

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ps-face-search-"));
    video = path.join(dir, "two-seconds.mp4");
    execFileSync(await resolveFfmpeg(), [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=25:duration=2",
        "-c:v",
        "mpeg4",
        video,
    ]);
});

afterAll(() => {
    stopModelChild();
    rmSync(dir, { recursive: true, force: true });
});

describe("searching from a frame", () => {
    it("reads the frame at the moment asked, finds nobody on it, and leaves nothing behind", async () => {
        const id = "integration-search";

        await expect(searchFrame(video, { id, mediaId: "m", atMs: 1000 })).resolves.toEqual([]);

        for (const scratch of [".webp", ".vec"]) {
            expect(
                existsSync(path.join(tmpdir(), `private-stock-face-search-${id}${scratch}`))
            ).toBe(false);
        }
    }, 120_000);

    it("refuses a moment past the end", async () => {
        await expect(
            searchFrame(video, { id: "past-the-end", mediaId: "m", atMs: 60_000 })
        ).rejects.toThrow();
    }, 120_000);
});
