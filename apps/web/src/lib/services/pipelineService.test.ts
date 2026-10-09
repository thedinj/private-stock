import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESSING_POLL_MS } from "@private-stock/core";

/**
 * The processing view's cache (§13c, §20).
 *
 * The answer costs the whole library's aggregates when cold, and the page asking for it polls.
 * What has to hold is the other side of that saving: a cached answer never hides progress for
 * longer than the client's poll would, an idle answer never survives work starting, and
 * anything this process does to the numbers is seen on the next ask.
 */

let reads = 0;
let liveJobs = 0;
let scanning = false;
let pending = 0;
let deferredTransactions = 0;

vi.mock("@private-stock/db", () => ({
    db: {
        transaction: (read: () => unknown) => ({
            deferred: () => {
                deferredTransactions += 1;

                return read();
            },
        }),
    },
    scanRepo: {
        currentRun: () => undefined,
        isAnyRunning: () => scanning,
    },
    jobRepo: {
        anyLive: () => liveJobs > 0,
        queueSummary: () => {
            reads += 1;

            return { pending, claimed: 0, failed: 0, workerAlive: false, byKind: [] };
        },
    },
    mediaRepo: {
        countProcessable: () => ({ image: 0, video: 0, probedImage: 0, probedVideo: 0 }),
    },
    stageRepo: { summary: () => [] },
    settingRepo: { get: <T>(_key: string, fallback: T) => fallback },
    mediaRootRepo: { findById: () => undefined },
}));

const { clearProcessingCache, getProcessingStatus } = await import("./pipelineService");

beforeEach(() => {
    vi.useFakeTimers();
    reads = 0;
    liveJobs = 0;
    scanning = false;
    pending = 0;
    deferredTransactions = 0;
    clearProcessingCache();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("getProcessingStatus", () => {
    it("reads under one deferred transaction, never the web default IMMEDIATE", () => {
        getProcessingStatus();

        expect(deferredTransactions).toBe(1);
    });

    it("reuses an idle answer for a minute", () => {
        getProcessingStatus();
        vi.advanceTimersByTime(59_000);
        getProcessingStatus();

        expect(reads).toBe(1);

        vi.advanceTimersByTime(2_000);
        getProcessingStatus();

        expect(reads).toBe(2);
    });

    it("recomputes an idle answer as soon as work has started", () => {
        getProcessingStatus();

        liveJobs = 3;
        pending = 3;

        expect(getProcessingStatus().queue.pending).toBe(3);
        expect(reads).toBe(2);
    });

    it("notices a scan starting on an idle library", () => {
        getProcessingStatus();
        scanning = true;
        getProcessingStatus();

        expect(reads).toBe(2);
    });

    it("never hides a busy answer for longer than one poll", () => {
        liveJobs = 1;
        pending = 1;
        getProcessingStatus();
        getProcessingStatus();

        expect(reads).toBe(1);

        vi.advanceTimersByTime(PROCESSING_POLL_MS);
        getProcessingStatus();

        expect(reads).toBe(2);
    });

    it("is cleared by anything this process changes", () => {
        getProcessingStatus();
        clearProcessingCache();
        getProcessingStatus();

        expect(reads).toBe(2);
    });
});
