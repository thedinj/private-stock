import { beforeEach, describe, expect, it, vi } from "vitest";

import { SETTING_KEYS } from "@private-stock/core";

import {
    CONCURRENCY,
    CPU_BOUND,
    THROTTLED,
    claimableKinds,
    cpuSlots,
    forgetThrottleSettings,
    isPolite,
    limitFor,
    processingPaused,
    quotaCores,
    runWithPoliteness,
    threadsPerJob,
    throttleState,
} from "./throttle.js";

let stored: Record<string, unknown> = {};

vi.mock("@private-stock/db", () => ({
    settingRepo: {
        get: (key: string, fallback: unknown) => storedSetting(key) ?? fallback,
    },
}));

const storedSetting = (key: string): unknown => stored[key];

/**
 * The worker half of §7c: how many slots a kind gets, and which work is exempt.
 *
 * The window arithmetic is tested in core. What is tested here is the part that decides
 * whether the feature does anything at all -- and the honest answer for some kinds is "no",
 * which is why the thread cap exists and why that fact is asserted rather than assumed.
 */

describe("limitFor", () => {
    it("hands out the full allowance while the window is open", () => {
        expect(limitFor("cover", false)).toBe(2);
        expect(limitFor("phash", false)).toBe(2);
    });

    it("narrows the kinds that saturate a core", () => {
        expect(limitFor("cover", true)).toBe(1);
        expect(limitFor("phash", true)).toBe(1);
    });

    /**
     * Probe is cheap and gates every stage that reads a stream. Throttling it would leave a
     * freshly imported item with no duration and no dimensions for hours, which reads as a
     * broken import rather than a considerate one.
     */
    it("leaves probing at full speed, because everything else waits on it", () => {
        expect(limitFor("probe", true)).toBe(2);
    });

    /**
     * The uncomfortable one, stated rather than buried.
     *
     * Transcode already runs one at a time at every hour, so the concurrency lever is a no-op
     * for the single job that saturates the box for minutes. If this test ever starts failing
     * because the full limit rose above one, the thread cap is no longer the only thing
     * holding an off-peak encode back and the settings copy needs rewriting.
     */
    it("cannot slow a transcode by concurrency alone, which is why the thread cap exists", () => {
        expect(limitFor("transcode", false)).toBe(1);
        expect(limitFor("transcode", true)).toBe(1);
    });

    it("never lets the throttled allowance exceed the full one", () => {
        for (const kind of Object.keys(CONCURRENCY)) {
            expect(limitFor(kind, true)).toBeLessThanOrEqual(limitFor(kind, false));
        }
    });

    /**
     * A throttled entry for a kind nobody claims is a setting with no effect, and a rename is
     * exactly how one appears -- silently, with every test still green.
     */
    it("has no throttled entry for a kind that does not exist", () => {
        for (const kind of Object.keys(THROTTLED)) {
            expect(CONCURRENCY).toHaveProperty(kind);
        }
    });

    it("bounds a kind it has never heard of rather than letting it run unbounded", () => {
        expect(limitFor("somethingNew", false)).toBe(1);
        expect(limitFor("somethingNew", true)).toBe(1);
    });
});

describe("politeness", () => {
    it("is off outside a job, so a startup backfill is not accidentally throttled", () => {
        expect(isPolite()).toBe(false);
    });

    /**
     * The reason this is `AsyncLocalStorage` and not a module-level flag.
     *
     * A sweep's cover job and a cover an admin just asked for are in flight at the same
     * moment, one polite and one exempt. A shared flag would hand whichever spawned second
     * the other's answer -- and the symptom would be an occasional slow button, which nobody
     * would ever trace back to here.
     */
    it("keeps concurrent jobs from reading each other's answer", async () => {
        const seen: boolean[] = [];

        const job = (polite: boolean, delay: number) =>
            runWithPoliteness(polite, async () => {
                await new Promise((resolve) => setTimeout(resolve, delay));
                // Read *after* the other job has started and set its own value.
                seen.push(isPolite());
            });

        await Promise.all([job(true, 20), job(false, 5)]);

        expect(seen).toEqual([false, true]);
    });

    it("restores the surrounding answer when a job finishes", () => {
        runWithPoliteness(true, () => {
            expect(isPolite()).toBe(true);
        });

        expect(isPolite()).toBe(false);
    });
});

/**
 * Which clock the window is read on (§7c).
 *
 * Note what does and does not discriminate here. An assertion naming the machine's *own*
 * zone passes under the old `getHours()` too, so on a developer box in Chicago the Chicago
 * cases prove nothing and on CI in UTC the UTC ones prove nothing. Each test below therefore
 * names at least two zones, so wherever it runs, one of them disagrees with the host.
 */
describe("throttleState across time zones", () => {
    beforeEach(() => {
        stored = {};
        forgetThrottleSettings();
    });

    const configure = (settings: Record<string, unknown>) => {
        stored[SETTING_KEYS.throttle] = { enabled: true, startHour: 2, endHour: 8, ...settings };
        forgetThrottleSettings();
    };

    /**
     * The bug this was written for.
     *
     * `getHours()` reads the container's clock, which on a stock QNAP image is UTC. An admin
     * in Chicago setting "full speed from 2 until 8" was configuring 20:00 to 02:00 of their
     * own evening -- the busiest hours of the day, throttled all night, and every screen in
     * the app agreeing with the setting, so nothing to notice.
     *
     * One instant, opposite answers: 08:30 UTC is hour 8 in Greenwich and so past the end of
     * a 2-to-8 window, and 02:30 in Chicago and so squarely inside it.
     */
    it("reads the window on the configured zone rather than the container's", () => {
        const at = new Date("2026-01-15T08:30:00Z");

        configure({ timeZone: "UTC" });
        expect(throttleState(at).throttled).toBe(true);

        configure({ timeZone: "America/Chicago" });
        expect(throttleState(at).throttled).toBe(false);

        // And the same in the other direction: 22:30 UTC is 07:30 the next day in Tokyo.
        configure({ timeZone: "Asia/Tokyo" });
        expect(throttleState(new Date("2026-01-14T22:30:00Z")).throttled).toBe(false);
        configure({ timeZone: "UTC" });
        expect(throttleState(new Date("2026-01-14T22:30:00Z")).throttled).toBe(true);
    });

    /**
     * Daylight saving, which is the reason this stores a zone and not an offset. The same
     * UTC instant falls inside the window in January and outside it in July, because Chicago
     * moves and the window does not.
     */
    it("moves with daylight saving", () => {
        configure({ timeZone: "America/Chicago", startHour: 2, endHour: 3 });

        // 08:30 UTC is 02:30 in Chicago on standard time, 03:30 on summer time.
        expect(throttleState(new Date("2026-01-15T08:30:00Z")).throttled).toBe(false);
        expect(throttleState(new Date("2026-07-15T08:30:00Z")).throttled).toBe(true);

        // Tokyo does not observe it, so the same pair of instants answers identically there.
        configure({ timeZone: "Asia/Tokyo", startHour: 17, endHour: 18 });
        expect(throttleState(new Date("2026-01-15T08:30:00Z")).throttled).toBe(false);
        expect(throttleState(new Date("2026-07-15T08:30:00Z")).throttled).toBe(false);
    });

    /** A window that wraps midnight, which is the obvious setting and the easy one to break. */
    it("handles a window that wraps midnight in the configured zone", () => {
        configure({ timeZone: "America/Chicago", startHour: 22, endHour: 6 });

        // 05:00 UTC is 23:00 in Chicago: inside 22-06.
        expect(throttleState(new Date("2026-01-15T05:00:00Z")).throttled).toBe(false);
        // 20:00 UTC is 14:00 in Chicago: outside it.
        expect(throttleState(new Date("2026-01-15T20:00:00Z")).throttled).toBe(true);

        // Read in Greenwich instead, the same window picks out different instants: 23:00 UTC
        // is inside it there and 17:00 -- well outside -- in Chicago.
        configure({ timeZone: "UTC", startHour: 22, endHour: 6 });
        expect(throttleState(new Date("2026-01-15T23:00:00Z")).throttled).toBe(false);
        expect(throttleState(new Date("2026-01-15T12:00:00Z")).throttled).toBe(true);
    });

    /**
     * A zone retired between the version that wrote it and the one reading it. Falling back
     * to the host is wrong by some number of hours; throwing inside the claim loop stops the
     * worker claiming anything at all.
     */
    it("keeps working when the stored zone is one this engine does not know", () => {
        configure({ timeZone: "America/Chicago" });
        stored[SETTING_KEYS.throttle] = {
            enabled: true,
            startHour: 2,
            endHour: 8,
            timeZone: "Middle/Earth",
        };
        forgetThrottleSettings();

        expect(() => throttleState(new Date("2026-01-15T08:30:00Z"))).not.toThrow();
    });
});

/**
 * The aggregate, which is the thing the per-kind table never bounded.
 *
 * These assert the shortfall as a number rather than describing it, so that adding a kind or
 * raising a limit cannot quietly restore the problem: if the sum drifts, the first two fail and
 * say by how much.
 */
describe("cpuSlots and the shared budget", () => {
    it("records that the per-kind limits alone bound almost nothing", () => {
        const sum = (throttled: boolean): number =>
            Object.keys(CONCURRENCY).reduce((total, kind) => total + limitFor(kind, throttled), 0);

        // The measurement that motivated the budget: throttling moved the ceiling by two (26 and
        // 24 when it was taken). `embed` and `faces` have since added one each at full speed and
        // none outside the window, where only requested passes run; `faceAnchors`,
        // `tagPictures` and `tagLookPictures` one each at both (`faceGroups`, gone with face
        // groups, was one more); `metadata` two at both, outside the budget like `probe`;
        // `tileprint` one at both; `segments` one at both.
        expect(sum(false)).toBe(35);
        expect(sum(true)).toBe(31);
    });

    it("leaves a core for the web process, and halves that inside the window", () => {
        expect(cpuSlots(false, 4)).toBe(3);
        expect(cpuSlots(true, 4)).toBe(1);
        expect(cpuSlots(false, 8)).toBe(7);
        expect(cpuSlots(true, 8)).toBe(3);
    });

    /**
     * A slot is only a core if the job in it uses one. ffmpeg sizes itself from the host's cores,
     * so under a two-core quota one uncapped job spent the whole allowance and the kernel froze
     * the web process with it.
     */
    it("gives each job only the threads its slot stands for", () => {
        // The NAS: two cores of quota, one CPU-bound job, one thread.
        expect(threadsPerJob(2)).toBe(1);
        // Four cores, three slots, a thread each — the fourth is the web process's.
        expect(threadsPerJob(4)).toBe(1);
        // A box the per-kind limits cannot fill shares its spare cores out instead.
        const runnable = [...CPU_BOUND].reduce((sum, kind) => sum + limitFor(kind, false), 0);
        expect(threadsPerJob(32)).toBe(Math.floor(31 / runnable));
    });

    it("never hands ffmpeg zero threads, which it reads as every core", () => {
        expect(threadsPerJob(1)).toBe(1);
    });

    it("never reaches zero, however small the box", () => {
        for (const cores of [1, 2]) {
            expect(cpuSlots(false, cores)).toBeGreaterThanOrEqual(1);
            expect(cpuSlots(true, cores)).toBeGreaterThanOrEqual(1);
        }
    });

    it("does not bind on a machine with cores to spare", () => {
        // The dev box. The budget must be larger than the per-kind limits can fill, or local
        // behaviour stops resembling the NAS's for reasons unrelated to the NAS.
        const cpuKinds = [...CPU_BOUND].reduce((total, kind) => total + limitFor(kind, false), 0);

        expect(cpuSlots(false, 32)).toBeGreaterThan(cpuKinds);
    });
});

/**
 * The embedder (§5e): the one kind stopped outside the window rather than slowed, because what it
 * holds is ~210 MB of model for as long as the backlog lasts, not only a core.
 */
describe("embed and the window", () => {
    const kinds = ["scan", "cover", "embed"];
    const idle = (): number => 0;

    it("holds a core, so it shares the budget with ffmpeg", () => {
        expect(CPU_BOUND.has("embed")).toBe(true);
    });

    it("runs flat out inside the window, one at a time", () => {
        expect(limitFor("embed", false)).toBe(1);
        expect(claimableKinds(kinds, idle, false, 2).free).toContain("embed");
    });

    it("takes no background work outside the window, and still takes what was asked for", () => {
        expect(limitFor("embed", true)).toBe(0);

        const { free, requested } = claimableKinds(kinds, idle, true, 2);

        expect(free).not.toContain("embed");
        expect(requested).toContain("embed");
    });

    it("waits for a free core like the rest, even when asked for", () => {
        // The NAS: one CPU slot, held by a sprite.
        const sprite = (kind: string) => (kind === "sprite" ? 1 : 0);

        for (const throttled of [false, true]) {
            const { free, requested } = claimableKinds(kinds, sprite, throttled, 2);

            expect(free).not.toContain("embed");
            expect(requested).not.toContain("embed");
        }
    });

    it("is requested-only while paused, inside the window or out", () => {
        for (const throttled of [false, true]) {
            const { free, requested } = claimableKinds(kinds, idle, throttled, 2, true);

            expect(free).not.toContain("embed");
            expect(requested).toContain("embed");
        }
    });

    it("never runs two at once, asked for or not: one child serves them all", () => {
        const one = (kind: string) => (kind === "embed" ? 1 : 0);

        for (const throttled of [false, true]) {
            const { free, requested } = claimableKinds(kinds, one, throttled, 8);

            expect(free).not.toContain("embed");
            expect(requested).not.toContain("embed");
        }
    });
});

describe("claimableKinds", () => {
    const kinds = ["scan", "filehash", "cover", "phash", "transcode"];
    const idle = (): number => 0;
    const busyWith = (counts: Record<string, number>) => (kind: string) => counts[kind] ?? 0;

    it("offers everything when nothing is running", () => {
        expect(claimableKinds(kinds, idle, false, 4).free).toEqual(kinds);
    });

    it("withholds CPU-bound kinds once the budget is full, and only those", () => {
        // Three cores' worth of ffmpeg on a four-core box: the budget is spent.
        const { free } = claimableKinds(kinds, busyWith({ cover: 2, phash: 1 }), false, 4);

        expect(free).toEqual(["scan", "filehash"]);
    });

    it("keeps I/O work moving while the budget is full", () => {
        // The reason the budget is not simply a cap on every kind: a scan is waiting on the
        // share, and stopping it would slow the library down to protect a core it never used.
        const { free } = claimableKinds(kinds, busyWith({ transcode: 1, cover: 2 }), false, 4);

        expect(free).toContain("scan");
        expect(free).toContain("filehash");
        expect(free).not.toContain("transcode");
    });

    it("does not let requested work through a full budget", () => {
        // The departure from the exemption: inside the window a kind at its throttled limit is
        // normally offered as `requested`. A spent budget withdraws it from both lists.
        const spent = busyWith({ cover: 1, phash: 1 });

        const { free, requested } = claimableKinds(kinds, spent, true, 4);

        expect(free).not.toContain("cover");
        expect(requested).not.toContain("cover");
    });

    it("still exempts requested work when the budget has room", () => {
        // The exemption itself must survive: `cover` is at its throttled limit of one and below
        // its full limit of two, with a core free, so somebody who asked for one may have it.
        const { free, requested } = claimableKinds(kinds, busyWith({ cover: 1 }), true, 8);

        expect(free).not.toContain("cover");
        expect(requested).toContain("cover");
    });
});

/**
 * The quota, which is the number that differs from what the box reports.
 *
 * `cpus: 2.0` on a four-core NAS is the deployed shape (docker-compose.qnap.yml), and it is the
 * case where reading `os.cpus()` gives an answer that is wrong in the permissive direction.
 */
describe("quotaCores", () => {
    it("reads a cgroup v2 limit", () => {
        expect(quotaCores("200000 100000", null, null)).toBe(2);
        expect(quotaCores("50000 100000\n", null, null)).toBe(0.5);
    });

    it("treats v2 `max` as no limit", () => {
        expect(quotaCores("max 100000", null, null)).toBeNull();
    });

    it("falls back to the cgroup v1 pair, which QTS kernels may still use", () => {
        expect(quotaCores(null, "200000", "100000")).toBe(2);
    });

    it("treats v1 -1 as no limit", () => {
        expect(quotaCores(null, "-1", "100000")).toBeNull();
    });

    it("returns null when there is no cgroup at all", () => {
        expect(quotaCores(null, null, null)).toBeNull();
    });

    it("does not let a malformed file license unlimited work", () => {
        expect(quotaCores("garbage", null, null)).toBeNull();
        expect(quotaCores("0 0", null, null)).toBeNull();
    });

    it("the deployed shape: four cores reported, two allowed, two budgeted", () => {
        // What the NAS actually looks like. Floor, not round -- 2.5 must not license three.
        const quota = quotaCores("200000 100000", null, null);

        expect(quota).toBe(2);
        expect(Math.max(1, Math.min(4, Math.floor(quota!)))).toBe(2);
        expect(cpuSlots(false, 2)).toBe(1);
        expect(cpuSlots(true, 2)).toBe(1);
    });
});

/**
 * The kill switch (§7c "Pausing"). Paused means background work waits while what somebody
 * asks for still runs — the whole point is tuning OCR on the bench while the library holds.
 */
describe("pausing", () => {
    const idle = () => 0;

    it("leaves only requested work, and the bin's moves, claimable", () => {
        const { free, requested } = claimableKinds(
            ["scan", "cover", "ocr", "ocrTrial", "trash"],
            idle,
            false,
            4,
            true
        );

        expect(free).toEqual(["trash"]);
        expect(requested.sort()).toEqual(["cover", "ocr", "ocrTrial", "scan"]);
    });

    it("changes nothing when not paused", () => {
        const kinds = ["scan", "cover", "trash"];

        expect(claimableKinds(kinds, idle, false, 4, false)).toEqual(
            claimableKinds(kinds, idle, false, 4)
        );
    });

    it("still holds requested work to the CPU budget", () => {
        // A pause is not a reason for the bench to take the web process's core (§7c).
        const busy = (kind: string) => (kind === "cover" ? 3 : 0);
        const { requested } = claimableKinds(["cover", "ocr"], busy, false, 4, true);

        expect(requested).not.toContain("ocr");
    });

    it("reads the switch, and reads a malformed one as not paused", () => {
        stored[SETTING_KEYS.pause] = { paused: true, since: null };
        vi.useFakeTimers();
        vi.advanceTimersByTime(5000);
        expect(processingPaused()).toBe(true);

        stored[SETTING_KEYS.pause] = { paused: "very" };
        vi.advanceTimersByTime(5000);
        expect(processingPaused()).toBe(false);
        vi.useRealTimers();
    });
});
