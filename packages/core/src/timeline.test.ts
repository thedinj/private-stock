import { describe, expect, it } from "vitest";

import {
    buildReelTimeline,
    formatFrameRate,
    msToFrames,
    parseFrameRateKey,
    rateShares,
    recommendedFrameRate,
    snapFrameRate,
    timecodeToFrames,
    type TimelineEntry,
    type TimelineSource,
} from "./timeline.js";

const NTSC = { num: 30000, den: 1001 };

const source = (mediaId: string, overrides: Partial<TimelineSource> = {}): TimelineSource => ({
    mediaId,
    fileName: `${mediaId}.mp4`,
    path: `\\\\NAS\\Videos\\${mediaId}.mp4`,
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    rate: { num: 30, den: 1 },
    timecode: null,
    hasAudio: true,
    audioChannels: 2,
    ...overrides,
});

const entry = (mediaId: string, startMs: number, endMs: number, speed: number | null = null) =>
    ({ mediaId, startMs, endMs, speed, label: null, keywords: [] }) satisfies TimelineEntry;

describe("snapFrameRate", () => {
    it("reads a rounded NTSC rate as the rational the camera meant", () => {
        expect(snapFrameRate(29.97)).toEqual(NTSC);
        expect(snapFrameRate(23.976)).toEqual({ num: 24000, den: 1001 });
        expect(snapFrameRate(59.94)).toEqual({ num: 60000, den: 1001 });
        expect(snapFrameRate(25)).toEqual({ num: 25, den: 1 });
    });

    it("never reads an exact rate as its NTSC neighbour, a tenth of a percent away", () => {
        expect(snapFrameRate(60)).toEqual({ num: 60, den: 1 });
        expect(snapFrameRate(30)).toEqual({ num: 30, den: 1 });
        expect(snapFrameRate(24)).toEqual({ num: 24, den: 1 });
    });

    it("keeps an odd rate as itself rather than forcing it onto a standard one", () => {
        expect(snapFrameRate(15)).toEqual({ num: 15, den: 1 });
        expect(snapFrameRate(12.5)).toEqual({ num: 25, den: 2 });
    });
});

describe("frame rate text", () => {
    it("round-trips the URL form", () => {
        expect(parseFrameRateKey("30000/1001")).toEqual(NTSC);
        expect(parseFrameRateKey("25")).toEqual({ num: 25, den: 1 });
        expect(parseFrameRateKey("0/1")).toBeNull();
        expect(parseFrameRateKey("abc")).toBeNull();
    });

    it("reads as a person writes it", () => {
        expect(formatFrameRate(NTSC)).toBe("29.97");
        expect(formatFrameRate({ num: 24000, den: 1001 })).toBe("23.976");
        expect(formatFrameRate({ num: 25, den: 1 })).toBe("25");
    });
});

describe("timecodeToFrames", () => {
    it("counts non-drop timecode plainly", () => {
        expect(timecodeToFrames("01:00:00:00", { num: 25, den: 1 })).toBe(90_000);
        expect(timecodeToFrames("00:00:01:05", { num: 30, den: 1 })).toBe(35);
    });

    it("skips the dropped frame numbers in drop-frame timecode", () => {
        // An hour of 29.97 is 107,892 frames, not 108,000: 108 numbers are skipped.
        expect(timecodeToFrames("01:00:00;00", NTSC)).toBe(107_892);
        // Minute one starts at ;02 -- the first frame after 00:00:59;29.
        expect(timecodeToFrames("00:01:00;02", NTSC)).toBe(1800);
    });

    it("refuses what is not a timecode", () => {
        expect(timecodeToFrames("1:2:3", NTSC)).toBeNull();
        expect(timecodeToFrames("00:00:00:30", NTSC)).toBeNull();
    });
});

describe("rateShares and recommendedFrameRate", () => {
    it("weighs by watching time, not by clip count", () => {
        const sources = [
            source("long", { rate: { num: 24000, den: 1001 } }),
            source("quick", { rate: { num: 60, den: 1 } }),
        ];
        const entries = [
            entry("long", 0, 20_000),
            entry("quick", 0, 1_000),
            entry("quick", 2_000, 3_000),
            entry("quick", 4_000, 5_000),
        ];
        const shares = rateShares(entries, sources);

        expect(shares.map((share) => share.clipCount)).toEqual([1, 3]);
        expect(recommendedFrameRate(shares)).toEqual({ num: 24000, den: 1001 });
    });

    it("counts a slowed clip by how long it takes to watch", () => {
        const sources = [source("a", { rate: { num: 25, den: 1 } }), source("b")];
        const shares = rateShares([entry("a", 0, 4_000, 0.25), entry("b", 0, 10_000)], sources);

        expect(shares[0]).toMatchObject({ rate: { num: 25, den: 1 }, runMs: 16_000 });
    });

    it("lets 30 and 29.97 vote together against a larger single 60", () => {
        const sources = [
            source("thirty"),
            source("ntsc", { rate: { num: 30000, den: 1001 } }),
            source("sixty", { rate: { num: 60, den: 1 } }),
        ];
        const shares = rateShares(
            [entry("sixty", 0, 4_000), entry("thirty", 0, 3_500), entry("ntsc", 0, 3_000)],
            sources
        );

        expect(recommendedFrameRate(shares)).toEqual({ num: 30, den: 1 });
    });

    it("moves an odd largest share to the nearest standard rate", () => {
        const shares = rateShares(
            [entry("a", 0, 1_000)],
            [source("a", { rate: { num: 15, den: 1 } })]
        );

        expect(recommendedFrameRate(shares)).toEqual({ num: 24000, den: 1001 });
        expect(recommendedFrameRate([])).toEqual({ num: 30, den: 1 });
    });
});

describe("buildReelTimeline", () => {
    it("lays clips end to end in whole sequence frames", () => {
        const timeline = buildReelTimeline({
            name: "Reel",
            description: null,
            rate: { num: 30, den: 1 },
            entries: [
                entry("a", 1_000, 2_500),
                entry("a", 10_000, 10_010),
                entry("b", 0, 4_000, 2),
            ],
            sources: [source("a"), source("b")],
        });

        expect(timeline.clips.map((clip) => [clip.offsetFrames, clip.durationFrames])).toEqual([
            [0, 45],
            // Ten milliseconds is a third of a frame and still gets one.
            [45, 1],
            // Four seconds at 2x runs two.
            [46, 60],
        ]);
        expect(timeline.durationFrames).toBe(106);
        expect(timeline.clips[0].sourceInFrames).toBe(30);
    });

    it("snaps the in-point on the source's own clock", () => {
        const timeline = buildReelTimeline({
            name: "Reel",
            description: null,
            rate: { num: 30, den: 1 },
            entries: [entry("pal", 1_000, 2_000)],
            sources: [source("pal", { rate: { num: 25, den: 1 } })],
        });

        expect(timeline.clips[0].sourceInFrames).toBe(25);
        expect(timeline.clips[0].durationFrames).toBe(30);
    });

    it("drops an entry whose source it was not given, and lists sources once", () => {
        const timeline = buildReelTimeline({
            name: "Reel",
            description: null,
            rate: NTSC,
            entries: [entry("a", 0, 1_000), entry("hidden", 0, 1_000), entry("a", 0, 1_000)],
            sources: [source("a")],
        });

        expect(timeline.clips).toHaveLength(2);
        expect(timeline.sources.map((s) => s.mediaId)).toEqual(["a"]);
    });

    it("names a clip by its label and falls back to the file name", () => {
        const timeline = buildReelTimeline({
            name: "Reel",
            description: null,
            rate: NTSC,
            entries: [{ ...entry("a", 0, 1_000), label: "  Jump  " }, entry("a", 0, 1_000)],
            sources: [source("a")],
        });

        expect(timeline.clips.map((clip) => [clip.name, clip.label])).toEqual([
            ["Jump", "Jump"],
            ["a.mp4", null],
        ]);
    });

    it("takes its frame size from the most-watched source", () => {
        const timeline = buildReelTimeline({
            name: "Reel",
            description: null,
            rate: NTSC,
            entries: [entry("tall", 0, 9_000), entry("wide", 0, 1_000)],
            sources: [source("tall", { width: 1080, height: 1920 }), source("wide")],
        });

        expect([timeline.width, timeline.height]).toEqual([1080, 1920]);
    });
});

describe("msToFrames", () => {
    it("rounds to the nearest frame at an NTSC rate", () => {
        expect(msToFrames(1_000, NTSC)).toBe(30);
        expect(msToFrames(60_000, NTSC)).toBe(1798);
    });
});
