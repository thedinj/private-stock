import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "../queue.js";

/**
 * The test bench's job (§5d "Settings and the test bench"). It must read each side with that
 * side's own settings, record a failure without abandoning the other side, and pick up a
 * comparison started again while it was running — the queue will not add a second job for it.
 */

interface Trial {
    id: string;
    mediaId: string;
    side: "current" | "candidate";
    settingsJson: string;
    state: "pending" | "running" | "done" | "failed";
    result?: unknown;
    error?: string;
}

let trials: Trial[] = [];
const readWith: unknown[] = [];
let failNext = false;
let onRead: (() => void) | null = null;

vi.mock("@private-stock/db", () => ({
    mediaRepo: { findBasic: () => ({ kind: "video", durationMs: 60_000 }) },
    ocrTrialRepo: {
        nextPending: (mediaId: string) =>
            trials.find((trial) => trial.mediaId === mediaId && trial.state === "pending"),
        markRunning: (id: string) => {
            const trial = trials.find((row) => row.id === id && row.state === "pending");
            if (trial) trial.state = "running";
            return trial !== undefined;
        },
        complete: (id: string, result: unknown) => {
            const trial = trials.find((row) => row.id === id);
            if (trial) Object.assign(trial, { state: "done", result });
        },
        fail: (id: string, error: string) => {
            const trial = trials.find((row) => row.id === id);
            if (trial) Object.assign(trial, { state: "failed", error });
        },
    },
}));

vi.mock("../media/sourcePath.js", () => ({
    resolveSource: () => ({ absolutePath: "/media/one.mp4" }),
}));

vi.mock("../media/readText.js", () => ({
    readText: async (_path: string, _timeline: boolean, _duration: number, settings: unknown) => {
        readWith.push(settings);
        onRead?.();

        if (failNext) {
            failNext = false;
            throw new Error("tesseract went away");
        }

        return {
            worth: [
                {
                    text: "SITE",
                    textNorm: "site",
                    confidence: 0.9,
                    occurrences: 3,
                    stability: 0.5,
                    firstAtMs: 1000,
                    lastAtMs: 5000,
                    box: { x: 0, y: 0, w: 0.1, h: 0.05 },
                },
            ],
            framesRead: 12,
        };
    },
}));

const { runOcrTrial } = await import("./ocrTrial.js");

const job: JobRow = {
    id: "job",
    kind: "ocrTrial",
    mediaId: "m1",
    fileId: "f1",
    payloadJson: null,
    attempts: 1,
    maxAttempts: 3,
    requestedByUserId: "u1",
};

const pair = (label: string): Trial[] => [
    {
        id: `${label}-current`,
        mediaId: "m1",
        side: "current",
        // Explicit on both axes, so the sides differ whatever the defaults are.
        settingsJson: JSON.stringify({ psm: 11, contrast: false }),
        state: "pending",
    },
    {
        id: `${label}-candidate`,
        mediaId: "m1",
        side: "candidate",
        settingsJson: JSON.stringify({ psm: 6, contrast: true }),
        state: "pending",
    },
];

beforeEach(() => {
    trials = pair("a");
    readWith.length = 0;
    failNext = false;
    onRead = null;
});

describe("a comparison", () => {
    it("reads each side with its own settings, and records what it found", async () => {
        await runOcrTrial(job, new AbortController().signal);

        expect(readWith).toEqual([
            expect.objectContaining({ psm: 11, contrast: false }),
            expect.objectContaining({ psm: 6, contrast: true }),
        ]);
        expect(trials.map((trial) => trial.state)).toEqual(["done", "done"]);
        expect(trials[0].result).toMatchObject({ framesRead: 12 });
        expect(JSON.parse((trials[0].result as { findingsJson: string }).findingsJson)).toEqual([
            {
                text: "SITE",
                textNorm: "site",
                confidence: 0.9,
                occurrences: 3,
                stability: 0.5,
                firstAtMs: 1000,
            },
        ]);
    });

    it("records a failed side and still reads the other", async () => {
        failNext = true;

        await runOcrTrial(job, new AbortController().signal);

        expect(trials.map((trial) => [trial.state, trial.error])).toEqual([
            ["failed", "tesseract went away"],
            ["done", undefined],
        ]);
    });

    it("runs a comparison started again while it was running", async () => {
        // The reader starts a new comparison during the first read: the old pair is replaced.
        onRead = () => {
            onRead = null;
            trials = pair("b");
        };

        await runOcrTrial(job, new AbortController().signal);

        expect(trials.map((trial) => [trial.id, trial.state])).toEqual([
            ["b-current", "done"],
            ["b-candidate", "done"],
        ]);
    });
});
