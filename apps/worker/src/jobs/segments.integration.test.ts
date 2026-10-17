import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSegmentPlaylist } from "@private-stock/core";

import { resolveFfmpeg } from "../media/binaries.js";

import { readKeyframes } from "./segments.js";

const execFileAsync = promisify(execFile);

/**
 * An MPEG-TS file played as byte ranges of itself (§8), against real ffmpeg.
 *
 * The unit tests prove the arithmetic. This proves the two things only a real file can: that
 * ffprobe's packet positions are where a segment can actually start, and that a player handed
 * the playlist decodes every segment of the untouched original from beginning to end.
 */

let workDir: string;
const CLIP = "show.ts";

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-segments-"));

    // Twenty seconds, a keyframe every two or three, with MP3 sound: the library's MPEG-TS.
    await execFileAsync(await resolveFfmpeg(), [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=25:d=20",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=20",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "60",
        "-keyint_min",
        "50",
        "-c:a",
        "libmp3lame",
        "-f",
        "mpegts",
        path.join(workDir, CLIP),
    ]);
}, 120_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("segments", () => {
    it("finds every keyframe, on a packet boundary", async () => {
        const keyframes = await readKeyframes(path.join(workDir, CLIP));

        // A keyframe every 60 frames at 25 fps over 20 seconds.
        expect(keyframes.length).toBeGreaterThanOrEqual(8);
        // A segment has to start where a TS packet does: 188 bytes each.
        expect(keyframes.every(([, pos]) => pos % 188 === 0)).toBe(true);
    });

    it("plays from the first segment to the last, as a player handed the playlist would", async () => {
        const clip = path.join(workDir, CLIP);
        const { size, mtimeMs } = await stat(clip);
        const playlist = buildSegmentPlaylist(
            {
                version: 1,
                sizeBytes: size,
                mtimeMs,
                durationMs: 20_000,
                keyframes: await readKeyframes(clip),
            },
            CLIP
        );
        const playlistPath = path.join(workDir, "show.m3u8");

        await writeFile(playlistPath, playlist);

        // Decoding every frame through the playlist: a broken segment boundary is an error here.
        const { stderr } = await execFileAsync(await resolveFfmpeg(), [
            "-v",
            "error",
            "-allowed_extensions",
            "ALL",
            "-i",
            playlistPath,
            "-f",
            "null",
            "-",
        ]);

        expect(stderr.trim()).toBe("");
        expect(playlist.match(/#EXT-X-BYTERANGE/g)?.length).toBeGreaterThanOrEqual(3);
    });
});
