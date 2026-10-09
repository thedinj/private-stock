import { describe, expect, it } from "vitest";

import {
    DEFAULT_DWELL,
    DWELL_CHOICES,
    dwellMs,
    remainingAfterPause,
    snapDwellSeconds,
    stageMode,
    stillSource,
} from "./stageDwell";

/**
 * The queue arithmetic for things that do not end by themselves (§14b).
 *
 * Every way this can be wrong is a way the show misbehaves silently: a stage that stalls
 * forever, a dwell of zero that flickers through a library, a clock that re-arms for an hour
 * because a tab was hidden for one.
 */

describe("which mode the stage is in", () => {
    it("gives a playable video the player", () => {
        expect(stageMode({ kind: "video", directPlay: true })).toBe("player");
    });

    it("gives an image the still stage", () => {
        expect(stageMode({ kind: "image", directPlay: true })).toBe("still");
        // `directPlay` is meaningless for an image and must not decide anything.
        expect(stageMode({ kind: "image", directPlay: false })).toBe("still");
    });

    it("gives a video awaiting a rendition the still stage rather than an empty one", () => {
        expect(stageMode({ kind: "video", directPlay: false })).toBe("still");
    });
});

describe("what a still stage shows", () => {
    it("streams an image's own bytes", () => {
        expect(stillSource({ id: "m1", kind: "image", coverUrl: null })).toBe(
            "/api/media/m1/stream"
        );
    });

    it("shows an unplayable video's cover instead of nothing", () => {
        expect(stillSource({ id: "m1", kind: "video", coverUrl: "/api/art/m1/cover" })).toBe(
            "/api/art/m1/cover"
        );
    });

    it("admits there is no picture when the cover stage has not run", () => {
        // Null rather than a throw: a stage with no picture is a real state, and it still has
        // to advance.
        expect(stillSource({ id: "m1", kind: "video", coverUrl: null })).toBeNull();
    });
});

describe("snapping a stored dwell", () => {
    it("keeps a value that is already on offer", () => {
        for (const choice of DWELL_CHOICES) {
            expect(snapDwellSeconds(choice)).toBe(choice);
            expect(snapDwellSeconds(String(choice))).toBe(choice);
        }
    });

    it("falls back to the default for anything unparseable", () => {
        for (const value of ["", "abc", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(snapDwellSeconds(value)).toBe(DEFAULT_DWELL);
        }
    });

    it("never yields a dwell that would strobe or stop the show", () => {
        // The values a hand-edited localStorage would produce. None may survive.
        expect(snapDwellSeconds(0)).toBe(3);
        expect(snapDwellSeconds(-5)).toBe(3);
        expect(snapDwellSeconds(1e9)).toBe(15);
    });

    it("snaps to the nearest offered value", () => {
        expect(snapDwellSeconds(4)).toBe(3);
        expect(snapDwellSeconds(6)).toBe(5);
        expect(snapDwellSeconds(7)).toBe(8);
        expect(snapDwellSeconds(12)).toBe(15);
    });
});

describe("whether a clock runs at all", () => {
    const base = { mode: "still", autoplayNext: true, hasNext: true, seconds: 5 } as const;

    it("runs for a still in a rolling set", () => {
        expect(dwellMs(base)).toBe(5_000);
    });

    it("does not run for a player, which ends by itself", () => {
        expect(dwellMs({ ...base, mode: "player" })).toBeNull();
    });

    it("does not run when rolling onward was never asked for", () => {
        expect(dwellMs({ ...base, autoplayNext: false })).toBeNull();
    });

    it("does not run at the end of the set", () => {
        // No wrap-around anywhere in the viewer: the last picture stays up.
        expect(dwellMs({ ...base, hasNext: false })).toBeNull();
    });
});

describe("holding and resuming the clock", () => {
    it("takes off what has already run", () => {
        expect(remainingAfterPause(5_000, 1_000, 3_000)).toBe(3_000);
    });

    it("floors at zero rather than re-arming for an hour", () => {
        // A tab hidden far longer than the dwell. Left signed, this would schedule a timeout
        // as long as the absence.
        expect(remainingAfterPause(5_000, 1_000, 3_600_000)).toBe(0);
    });

    it("loses nothing when paused in the same instant it was armed", () => {
        expect(remainingAfterPause(5_000, 1_000, 1_000)).toBe(5_000);
    });
});
