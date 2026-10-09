import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchOutPoint, type OutPointSource } from "./outPoint";

/**
 * Stopping at a span's out point (§14d).
 *
 * Two of these cover bugs that shipped and were found by watching the thing rather than by
 * reading it: a preview that moved the playhead and then ran on into the rest of the film, and
 * a second press on the clip that had just finished doing nothing at all.
 */

interface Fake extends OutPointSource {
    fire: (event: string) => void;
    listenerCount: () => number;
}

const fakeVideo = (options: { rvfc?: boolean } = {}): Fake => {
    const listeners = new Map<string, Set<() => void>>();
    let queued: (() => void) | null = null;

    const self: Fake = {
        currentTime: 0,
        playbackRate: 1,
        paused: false,
        pause: vi.fn(() => {
            self.paused = true;
        }),
        addEventListener: (type, listener) => {
            const set = listeners.get(type) ?? new Set();

            set.add(listener);
            listeners.set(type, set);
        },
        removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
        fire: (event) => listeners.get(event)?.forEach((listener) => listener()),
        listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
        ...(options.rvfc
            ? {
                  requestVideoFrameCallback: (callback: () => void) => {
                      queued = callback;

                      return 1;
                  },
                  cancelVideoFrameCallback: () => {
                      queued = null;
                  },
              }
            : {}),
    };

    // Presenting a frame, for the rVFC path.
    Object.defineProperty(self, "present", {
        value: () => {
            const next = queued;

            queued = null;
            next?.();
        },
    });

    return self;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("reaching the out point", () => {
    it("pauses the element before telling anybody", () => {
        const video = fakeVideo();
        const order: string[] = [];

        video.pause = vi.fn(() => {
            video.paused = true;
            order.push("pause");
        });

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, () => order.push("callback"));

        video.currentTime = 10;
        video.fire("timeupdate");

        // The stop is the player's job, not each caller's: a preview with nothing after it has
        // to end, and a reel must not rely on the next span's seek to halt the overshoot.
        expect(order).toEqual(["pause", "callback"]);
    });

    it("fires once, however many events arrive after it", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 10;
        video.fire("timeupdate");
        video.fire("timeupdate");
        video.fire("seeked");

        expect(onReached).toHaveBeenCalledTimes(1);
    });

    it("does not fire before the span ends", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 4;
        video.fire("timeupdate");

        expect(onReached).not.toHaveBeenCalled();
        expect(video.pause).not.toHaveBeenCalled();
    });
});

describe("the timer", () => {
    it("takes over close to the out point, landing between timeupdates", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        // 200ms out: inside the arming window, so a timer is set rather than waiting for a
        // `timeupdate` that could be another 250ms away.
        video.currentTime = 9.8;
        video.fire("timeupdate");

        expect(onReached).not.toHaveBeenCalled();
        vi.advanceTimersByTime(200);
        expect(onReached).toHaveBeenCalledTimes(1);
    });

    it("scales the wait by the clip's own speed", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        // Half speed: 200ms of the span is 400ms of wall clock. Armed as if it were 1x, this
        // would cut the span short.
        watchOutPoint(video, { endMs: 10_000, speed: 0.5 }, 1, onReached);

        video.currentTime = 9.8;
        video.fire("timeupdate");

        vi.advanceTimersByTime(399);
        expect(onReached).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onReached).toHaveBeenCalledTimes(1);
    });

    it("re-arms on a seek backwards, rather than ending the span early", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 9.8;
        video.fire("timeupdate");

        // Scrubbing back inside the span cancels the timer that was about to fire.
        video.currentTime = 2;
        video.fire("seeking");

        vi.advanceTimersByTime(5_000);
        expect(onReached).not.toHaveBeenCalled();
    });

    it("arms nothing while paused", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        video.paused = true;
        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 9.9;
        video.fire("pause");

        vi.advanceTimersByTime(5_000);
        expect(onReached).not.toHaveBeenCalled();
    });
});

describe("the frame callback", () => {
    it("ends the span within a frame where the browser has it", () => {
        const video = fakeVideo({ rvfc: true });
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 10;
        (video as unknown as { present: () => void }).present();

        // No `timeupdate` needed: this is the layer that lands on the frame rather than up to a
        // quarter of a second after it.
        expect(onReached).toHaveBeenCalledTimes(1);
    });
});

describe("teardown", () => {
    it("removes everything it added", () => {
        const video = fakeVideo();
        const stop = watchOutPoint(video, { endMs: 10_000, speed: null }, 1, vi.fn());

        expect(video.listenerCount()).toBeGreaterThan(0);
        stop();
        expect(video.listenerCount()).toBe(0);
    });

    it("lets a second watch arm again, which is what asking twice depends on", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        // The first span ends.
        const stop = watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 10;
        video.fire("timeupdate");
        stop();

        expect(onReached).toHaveBeenCalledTimes(1);

        // Pressing preview again on the same clip: a fresh watch, a fresh latch. Without the
        // arrival token in the hook this binding would never be rebuilt and the span would run on.
        video.paused = false;
        video.currentTime = 1;
        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 10;
        video.fire("timeupdate");

        expect(onReached).toHaveBeenCalledTimes(2);
    });
});

describe("after the span has ended", () => {
    it("refuses to resume, so a finished reel does not run on into the file", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 10;
        video.fire("timeupdate");
        expect(video.paused).toBe(true);

        // Pressing play at the end of a reel used to resume the underlying file at the out point
        // and keep going: the latch had fired, so nothing was left watching.
        video.paused = false;
        video.fire("play");

        expect(video.pause).toHaveBeenCalledTimes(2);
        expect(video.paused).toBe(true);
    });

    it("still arms normally on a play that is not at the end", () => {
        const video = fakeVideo();
        const onReached = vi.fn();

        watchOutPoint(video, { endMs: 10_000, speed: null }, 1, onReached);

        video.currentTime = 9.8;
        video.fire("play");

        vi.advanceTimersByTime(200);
        expect(onReached).toHaveBeenCalledTimes(1);
    });
});
