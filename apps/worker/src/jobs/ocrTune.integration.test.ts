import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { TuneResult } from "@private-stock/core";

import { resolveFfmpeg } from "../media/binaries.js";
import type { JobRow } from "../queue.js";

/**
 * A tuning run end to end, with the real ffmpeg and Tesseract (§5d "Tuning against expected
 * text"). The database is faked; the frames, the cache on disk and the search are not.
 */

const execFileAsync = promisify(execFile);

let workDir: string;
let dataDir: string;
let videoPath: string;
let size = 0;
let mtime = 0;

interface Run {
    id: string;
    state: string;
    mode: "quick" | "thorough";
    costWeight: "low" | "medium" | "high";
    resultJson: string | null;
    error: string | null;
}

let run: Run;

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
}));

vi.mock("@private-stock/db", () => ({
    settingRepo: {
        get: (key: string, fallback: unknown) =>
            key === "ocr.testSet"
                ? [{ mediaId: "m1", expected: ["AURORA"], complete: true }]
                : fallback,
    },
    ocrTuneRepo: {
        findById: () => run,
        markRunning: () => {
            run.state = "running";
            return true;
        },
        setProgress: () => undefined,
        complete: (_id: string, resultJson: string) => {
            Object.assign(run, { state: "done", resultJson });
        },
        finish: (_id: string, state: string, error: string | null) => {
            Object.assign(run, { state, error });
        },
        listSources: () => [
            { mediaId: "m1", fileId: "f1", kind: "video", durationMs: 12_000, size, mtime },
        ],
    },
    // Imported by modules this job imports; not used by it.
    mediaRepo: {},
    mediaTextRepo: {},
    searchRepo: {},
}));

vi.mock("../media/sourcePath.js", () => ({
    resolveSource: () => ({ absolutePath: videoPath, rootId: "root", relPath: "watermark.mp4" }),
}));

const { runOcrTune } = await import("./ocrTune.js");

const fontFile = (): string =>
    process.platform === "win32"
        ? "C\\:/Windows/Fonts/arialbd.ttf"
        : process.platform === "darwin"
          ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
          : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "ps-tune-it-"));
    dataDir = path.join(workDir, "data");
    videoPath = path.join(workDir, "watermark.mp4");

    const ffmpeg = await resolveFfmpeg();

    await execFileAsync(
        ffmpeg,
        [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=640x360:d=12:r=5",
            "-vf",
            `drawtext=fontfile='${fontFile()}':text='AURORA':fontcolor=white:fontsize=34:x=40:y=30`,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            videoPath,
        ],
        { timeout: 120_000 }
    );

    const stats = await stat(videoPath);
    size = stats.size;
    mtime = Math.floor(stats.mtimeMs);
}, 180_000);

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

const job: JobRow = {
    id: "job",
    kind: "ocrTune",
    mediaId: null,
    fileId: null,
    payloadJson: JSON.stringify({ runId: "run" }),
    attempts: 1,
    maxAttempts: 1,
    requestedByUserId: "u1",
};

const tune = async (): Promise<TuneResult> => {
    run = {
        id: "run",
        state: "pending",
        mode: "quick",
        costWeight: "medium",
        resultJson: null,
        error: null,
    };

    await runOcrTune(job, new AbortController().signal);

    expect(run.error).toBeNull();
    expect(run.state).toBe("done");

    return JSON.parse(run.resultJson!) as TuneResult;
};

describe("tuning against expected text", () => {
    it("finds settings that read what was expected, and nothing else", async () => {
        const result = await tune();

        expect(result.picks.quality.recall).toBe(1);
        expect(result.picks.quality.junkRate).toBe(0);
        expect(result.evaluated).toBeGreaterThan(100);
        expect(result.framesExtracted).toBeGreaterThan(0);
    }, 600_000);

    it("reads nothing the second time, because every frame is cached", async () => {
        const result = await tune();

        expect(result.framesExtracted).toBe(0);
    }, 600_000);
});
