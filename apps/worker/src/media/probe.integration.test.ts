import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "./binaries.js";
import { readEmbeddedText } from "./probe.js";

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
