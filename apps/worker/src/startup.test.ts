import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { firstRunAfter, inStartupGrace, scheduleDeferred, type DeferredStep } from "./startup.js";

/**
 * The startup grace (§20): nothing heavy in the minutes after a deploy, and nothing dropped.
 *
 * The schedule is asserted as relations rather than as numbers, because the relations are the
 * guarantees — the scan after the watchers, the sweep after the scan, everything heavy after
 * the grace and nothing in the same minute as anything else.
 */
const GRACE = 5 * 60_000;

const STEPS: DeferredStep[] = [
    "claimBackground",
    "watchAndScan",
    "sweep",
    "housekeeping",
    "orphanSweep",
];

describe("the startup schedule", () => {
    it("runs nothing deferred before the grace is over", () => {
        for (const step of STEPS) {
            expect(firstRunAfter(step, GRACE)).toBeGreaterThanOrEqual(GRACE);
        }
    });

    it("resumes background claiming exactly when the grace ends", () => {
        expect(firstRunAfter("claimBackground", GRACE)).toBe(GRACE);
    });

    /**
     * The order is the correctness argument for deferring the scan at all: once watchers are up,
     * a change is seen by either the scan or the events. The sweep follows the scan so it does
     * not find a pass early the items the scan is about to queue probes for.
     */
    it("starts watching and scanning before the sweeps, and the orphan sweep last", () => {
        const at = (step: DeferredStep) => firstRunAfter(step, GRACE);

        expect(at("watchAndScan")).toBeLessThan(at("sweep"));
        expect(at("sweep")).toBeLessThan(at("housekeeping"));
        expect(at("housekeeping")).toBeLessThan(at("orphanSweep"));
    });

    it("keeps the heavy steps at least a minute apart at the production grace", () => {
        const heavy: DeferredStep[] = ["watchAndScan", "sweep", "housekeeping", "orphanSweep"];
        const times = heavy.map((step) => firstRunAfter(step, GRACE));

        for (let i = 1; i < times.length; i += 1) {
            expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(60_000);
        }
    });

    it("scales with the grace, so a short development grace is short throughout", () => {
        expect(firstRunAfter("orphanSweep", 15_000)).toBeLessThan(2 * 60_000);
    });

    it("knows when the grace is over", () => {
        expect(inStartupGrace(1_000, 1_000 + GRACE - 1, GRACE)).toBe(true);
        expect(inStartupGrace(1_000, 1_000 + GRACE, GRACE)).toBe(false);
    });
});

describe("scheduleDeferred", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("runs first after the delay, then on the interval counted from that run", () => {
        const task = vi.fn();

        scheduleDeferred(1_000, 500, task);

        vi.advanceTimersByTime(999);
        expect(task).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(task).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1_000);
        expect(task).toHaveBeenCalledTimes(3);
    });

    it("runs a one-off once", () => {
        const task = vi.fn();

        scheduleDeferred(1_000, null, task);
        vi.advanceTimersByTime(10_000);

        expect(task).toHaveBeenCalledTimes(1);
    });

    it("stops before its first run", () => {
        const task = vi.fn();

        scheduleDeferred(1_000, 500, task)();
        vi.advanceTimersByTime(10_000);

        expect(task).not.toHaveBeenCalled();
    });

    it("stops after it has started repeating", () => {
        const task = vi.fn();
        const stop = scheduleDeferred(1_000, 500, task);

        vi.advanceTimersByTime(1_500);
        stop();
        vi.advanceTimersByTime(10_000);

        expect(task).toHaveBeenCalledTimes(2);
    });
});
