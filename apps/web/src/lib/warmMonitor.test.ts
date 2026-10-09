import { describe, expect, it } from "vitest";

import { initialSlots } from "./videoSlots";
import {
    classifyJoin,
    covers,
    describeJoin,
    formatMs,
    offTarget,
    type JoinRecord,
} from "./warmMonitor";

/**
 * The warming overlay's arithmetic (§8b, "Seeing it work").
 *
 * The overlay is only worth having if it tells the truth, and the two places it could lie are
 * here: calling a join a swap when it was cold, and calling a buffer ready when it holds the
 * wrong part of the file.
 */

describe("how a player arrived", () => {
    const warmed = { ids: ["a", "b"] as const, active: 0 as const };

    it("calls arriving at the warmed element a swap", () => {
        expect(classifyJoin(warmed, "b", false)).toBe("swap");
    });

    /** A reel's A, then A again: the element already showing, sent somewhere else. */
    it("calls arriving at the element on screen a seek", () => {
        expect(classifyJoin(warmed, "a", false)).toBe("seek");
    });

    it("calls an item nobody saw coming cold", () => {
        expect(classifyJoin(warmed, "c", false)).toBe("cold");
        expect(classifyJoin(initialSlots("a"), "c", false)).toBe("cold");
    });

    it("calls a held element let go a cue, whatever its slot", () => {
        expect(classifyJoin(warmed, "c", true)).toBe("cue");
    });
});

describe("whether the buffer holds the start", () => {
    it("is covered when a range contains it", () => {
        expect(covers([[99_800, 112_300]], 100_000)).toBe(true);
    });

    /**
     * The failure §8b names: bandwidth spent on the opening titles of a file the reel joins at
     * 01:40. Plenty buffered, none of it the part that will be played.
     */
    it("is not covered by a buffer of the wrong part of the file", () => {
        expect(covers([[0, 30_000]], 100_000)).toBe(false);
    });

    it("allows a range that stops just short, read before the seek landed", () => {
        expect(covers([[100_200, 110_000]], 100_000)).toBe(true);
        expect(covers([[101_000, 110_000]], 100_000)).toBe(false);
    });

    it("is not covered by nothing", () => {
        expect(covers([], 0)).toBe(false);
    });
});

const join = (change: Partial<JoinRecord>): JoinRecord => ({
    id: 1,
    participant: "p",
    source: "reel",
    kind: "swap",
    mediaId: "3f9a0c12-0000-0000-0000-000000000000",
    targetMs: 100_000,
    covered: true,
    readyState: 4,
    outcome: "ready",
    readyMs: 41,
    playingMs: null,
    aheadMs: null,
    landedMs: 100_000,
    events: [],
    ...change,
});

describe("where the first picture landed", () => {
    it("is on target at the start", () => {
        expect(offTarget(join({}))).toBe(false);
    });

    it("is off target somewhere else entirely", () => {
        expect(offTarget(join({ landedMs: 192_000 }))).toBe(true);
    });

    it("says nothing about a still, which has no timeline", () => {
        expect(offTarget(join({ targetMs: null, landedMs: null }))).toBe(false);
    });
});

describe("the console line", () => {
    it("says what happened in one line", () => {
        expect(describeJoin(join({}))).toBe(
            "[warm] SWAP reel 3f9a0c12… @01:40.000 covered ✓ rs=4 → picture in 41 ms"
        );
    });

    it("carries the playback timeline, which is where a stall shows", () => {
        expect(
            describeJoin(
                join({
                    aheadMs: 300,
                    playingMs: 2_410,
                    events: [
                        { atMs: 3, name: "play" },
                        { atMs: 45, name: "waiting" },
                        { atMs: 2_410, name: "playing" },
                    ],
                })
            )
        ).toBe(
            "[warm] SWAP reel 3f9a0c12… @01:40.000 covered ✓ 300 ms ahead rs=4 → picture in 41 ms " +
                "playing in 2.4 s · play 3, waiting 45, playing 2410"
        );
    });

    it("shouts about a picture in the wrong place", () => {
        expect(describeJoin(join({ landedMs: 192_000 }))).toContain("at 03:12.000 ✗ OFF TARGET");
    });

    it("formats minutes past the hour rather than wrapping", () => {
        expect(formatMs(3_725_500)).toBe("62:05.500");
    });
});
