import { describe, expect, it } from "vitest";

import {
    BITRATE_BANDS,
    DURATION_BANDS,
    FPS_BANDS,
    RESOLUTION_BANDS,
    SIZE_BANDS,
    bandFor,
    describeRange,
    type RangeBand,
} from "./ranges.js";

/**
 * That the bands cover their axis, checked rather than asserted in a comment (§14e).
 *
 * A gap between two bands is not a missing feature — it is a file that no offered filter can
 * find, and it presents as nothing at all: the filter works, the results look reasonable, and
 * one item is quietly unreachable. It is also the kind of mistake that arrives later, when
 * somebody adjusts a boundary on one side and not the other, which is exactly what a test is
 * for and what a comment is not.
 */

const ALL_BANDS: [string, RangeBand[]][] = [
    ["duration", DURATION_BANDS],
    ["resolution", RESOLUTION_BANDS],
    ["bitrate", BITRATE_BANDS],
    ["frame rate", FPS_BANDS],
    ["size", SIZE_BANDS],
];

describe.each(ALL_BANDS)("the %s bands", (_name, bands) => {
    it("starts open at the bottom, so nothing is too small to appear", () => {
        expect(bands[0].min).toBeUndefined();
    });

    it("ends open at the top, so nothing is too large to appear", () => {
        expect(bands[bands.length - 1].max).toBeUndefined();
    });

    /**
     * Each band begins exactly where the one before it ends. A gap loses files; an overlap
     * puts one file under two filters that are offered as alternatives, which makes the
     * counts stop adding up.
     */
    it("meets its neighbours exactly, with no gap and no overlap", () => {
        for (let i = 1; i < bands.length; i += 1) {
            expect(bands[i].min).toBe(bands[i - 1].max);
        }
    });

    it("is ordered, so the chips read low to high", () => {
        for (const band of bands) {
            if (band.min !== undefined && band.max !== undefined) {
                expect(band.max).toBeGreaterThan(band.min);
            }
        }
    });

    it("gives every band a label and a distinct id", () => {
        expect(bands.every((band) => band.label.length > 0)).toBe(true);
        expect(new Set(bands.map((band) => band.id)).size).toBe(bands.length);
    });
});

/** The band a value falls in, by the half-open rule the filters use. */
const bandOf = (bands: RangeBand[], value: number): RangeBand | undefined =>
    bands.find(
        (band) =>
            (band.min === undefined || value >= band.min) &&
            (band.max === undefined || value < band.max)
    );

describe("where an awkward value lands", () => {
    /**
     * The question that started this. 719 is not 720p, and there has to be somewhere it goes
     * — the label now says where instead of leaving it to be worked out from the chip beside
     * it.
     */
    it("files a 719-pixel file as SD, and says so on the chip", () => {
        const band = bandOf(RESOLUTION_BANDS, 719);

        expect(band?.id).toBe("sd");
        expect(band?.label).toBe("SD (under 720)");
    });

    it("files an 800-pixel file as 720p, which is the class it belongs to", () => {
        expect(bandOf(RESOLUTION_BANDS, 800)?.id).toBe("hd");
    });

    it("puts a boundary value in the upper band only", () => {
        expect(bandOf(RESOLUTION_BANDS, 1_080)?.id).toBe("fhd");
        expect(bandOf(DURATION_BANDS, 300)?.id).toBe("medium");
    });

    /**
     * The mislabel this test was written for. The band covering 31–60 was called "48–60",
     * which told anybody holding a 45 fps file to look elsewhere — and there is nowhere else.
     */
    it("names the frame-rate band after its edges rather than its contents", () => {
        const band = bandOf(FPS_BANDS, 45);

        expect(band?.id).toBe("smooth");
        expect(band?.label).toBe("31–60");
    });

    it("keeps the broadcast rates with the round numbers they are named after", () => {
        expect(bandOf(FPS_BANDS, 23.976)?.id).toBe("cinema");
        expect(bandOf(FPS_BANDS, 29.97)?.id).toBe("standard");
        expect(bandOf(FPS_BANDS, 59.94)?.id).toBe("smooth");
    });

    it.each(ALL_BANDS)("leaves no value of %s unplaced", (_name, bands) => {
        const edges = bands
            .flatMap((band) => [band.min, band.max])
            .filter((n): n is number => n !== undefined);
        // Either side of every boundary, plus well outside both ends.
        const probes = [0, ...edges.flatMap((edge) => [edge - 0.5, edge, edge + 0.5]), 1e9];

        for (const value of probes.filter((n) => n >= 0)) {
            expect(bandOf(bands, value), `nothing covers ${value}`).toBeDefined();
        }
    });
});

describe("describing a range", () => {
    it("uses the band's own name when the bounds are one", () => {
        expect(describeRange(RESOLUTION_BANDS, 1_080, 1_440, "px")).toBe("1080p (1080–1439)");
    });

    it("falls back to the numbers for a range nobody preset", () => {
        expect(describeRange(RESOLUTION_BANDS, 900, 1_000, "px")).toBe("900–1000 px");
        expect(describeRange(RESOLUTION_BANDS, 900, null, "px")).toBe("900 px and up");
        expect(describeRange(RESOLUTION_BANDS, null, 900, "px")).toBe("under 900 px");
    });

    it("says nothing at all when nothing is bounded", () => {
        expect(describeRange(RESOLUTION_BANDS, null, null, "px")).toBeNull();
        expect(bandFor(RESOLUTION_BANDS, null, null)).toBeNull();
    });
});
