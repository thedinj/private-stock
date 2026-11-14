import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "./binaries.js";
import { probeFile, readEmbeddedText, readTiming } from "./probe.js";

const execFileAsync = promisify(execFile);

/**
 * The tags a file carries about itself, against real ffmpeg (§5b).
 *
 * MP4 and Matroska spell the same tag differently -- `title` against `TITLE` -- and only a
 * file written by the muxer proves the reader sees both, and ignores what the encoder adds.
 */

let workDir: string;

const write = async (name: string, metadata: Record<string, string>): Promise<string> => {
    const file = path.join(workDir, name);

    await execFileAsync(await resolveFfmpeg(), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=5:duration=1",
        ...Object.entries(metadata).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
        "-c:v",
        "mpeg4",
        file,
    ]);

    return file;
};

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-probe-"));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("readEmbeddedText", () => {
    it("keeps the descriptive tags of an MP4 and drops the encoder's", async () => {
        const file = await write("tagged.mp4", {
            title: "  A title  ",
            comment: "Posted by @someone",
            artist: "Some Site",
            description: "<p>Copied from   <b>a post</b></p>",
            genre: "ignored",
        });

        expect(Object.fromEntries(await readEmbeddedText(file))).toEqual({
            title: "A title",
            comment: "Posted by @someone",
            artist: "Some Site",
            description: "Copied from a post",
        });
    });

    it("reads Matroska's uppercase keys as the same tags", async () => {
        const file = await write("tagged.mkv", { title: "Mkv title", description: "Words" });

        expect(Object.fromEntries(await readEmbeddedText(file))).toEqual({
            title: "Mkv title",
            description: "Words",
        });
    });

    it("finds nothing in a file that says nothing", async () => {
        const file = await write("plain.mp4", {});

        expect((await readEmbeddedText(file)).size).toBe(0);
    });
});

/** A two-second test pattern with whatever extra arguments the case needs (§14d). */
const encode = async (name: string, source: string, args: string[] = []): Promise<string> => {
    const file = path.join(workDir, name);

    await execFileAsync(await resolveFfmpeg(), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        source,
        "-t",
        "2",
        ...args,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        file,
    ]);

    return file;
};

describe("probeFile timing facts for editor export", () => {
    it("reads an NTSC rate as its rational and keeps the start timecode", async () => {
        const file = await encode("ntsc.mp4", "testsrc=size=64x64:rate=30000/1001", [
            "-timecode",
            "01:00:00;00",
        ]);
        const probe = await probeFile(file);

        expect([probe.fpsNum, probe.fpsDen]).toEqual([30000, 1001]);
        expect(probe.timecodeStart).toBe("01:00:00;00");
        expect(probe.isVfr).toBe(false);
    });

    it("keeps an exact 60 exact and finds no timecode where none was written", async () => {
        const probe = await probeFile(await encode("sixty.mp4", "testsrc=size=64x64:rate=60"));

        expect([probe.fpsNum, probe.fpsDen]).toEqual([60, 1]);
        expect(probe.timecodeStart).toBeNull();
    });

    it("flags a file whose frames arrive at a varying rate", async () => {
        // Thirty frames a second for the first half second, then ten: what a phone does in
        // low light, and what an editor conforms.
        const file = await encode("vfr.mp4", "testsrc=size=64x64:rate=30", [
            "-vf",
            "setpts='if(lt(N,15),N/30,0.5+(N-15)/10)/TB'",
            "-fps_mode",
            "vfr",
        ]);

        expect((await probeFile(file)).isVfr).toBe(true);
    });

    it("reads the same facts on their own, for the timing stage's sweep", async () => {
        const file = await encode("timing.mp4", "testsrc=size=64x64:rate=25", [
            "-timecode",
            "10:00:00:00",
        ]);

        expect(await readTiming(file)).toEqual({
            fpsNum: 25,
            fpsDen: 1,
            isVfr: false,
            timecodeStart: "10:00:00:00",
        });
    });
});
