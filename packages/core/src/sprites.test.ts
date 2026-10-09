import { describe, expect, it } from "vitest";

import {
    MAX_INTERVAL_MS,
    MIN_INTERVAL_MS,
    SPRITE_COLUMNS,
    TARGET_TILE_COUNT,
    TILES_PER_SHEET,
    buildSpriteVtt,
    cueAt,
    formatVttTimestamp,
    parseSpriteVtt,
    parseVttTimestamp,
    spriteLayout,
    spriteTileAt,
} from "./sprites.js";

/**
 * Sprite arithmetic decides two things that are invisible until they are expensive: how much
 * disk a 200k-item library spends on scrubbing, and whether the thumbnail under the pointer
 * is the frame you are pointing at.
 */
describe("spriteLayout", () => {
    it("bounds the tile count whatever the duration", () => {
        // A fixed interval gives a 30-second clip three thumbnails and a three-hour film a
        // thousand. Targeting a count instead keeps both usable and bounds the disk cost.
        for (const minutes of [0.5, 2, 10, 45, 90, 180, 480]) {
            const layout = spriteLayout(minutes * 60_000);

            expect(layout.tileCount).toBeGreaterThan(0);
            expect(layout.tileCount).toBeLessThanOrEqual(1000);
            expect(layout.sheetCount).toBe(Math.ceil(layout.tileCount / TILES_PER_SHEET));
        }
    });

    /**
     * The target is never exceeded until the interval hits its ceiling.
     *
     * Which is the property the disk estimate rests on: below that point every video costs at
     * most `TARGET_TILE_COUNT` tiles no matter how the rounding falls, so a 200k-item library
     * has a number rather than a hope.
     */
    it("never exceeds the target while the interval can still stretch", () => {
        for (const minutes of [0.5, 2, 5, 7.5, 12, 20, 25, 40, 49]) {
            expect(spriteLayout(minutes * 60_000).tileCount).toBeLessThanOrEqual(TARGET_TILE_COUNT);
        }
    });

    /**
     * One sheet for anything under 50 minutes — where the library actually lives.
     *
     * The grid holds exactly the target for this reason: the common case becomes one file, one
     * request and one decode, and the multi-sheet path stays a long-film special case rather
     * than the norm.
     */
    it("fits a typical video in a single sheet", () => {
        for (const minutes of [1, 5, 12, 25, 40, 49]) {
            expect(spriteLayout(minutes * 60_000).sheetCount).toBe(1);
        }

        // Past the interval ceiling the tile count grows with the runtime again.
        expect(spriteLayout(120 * 60_000).sheetCount).toBeGreaterThan(1);
    });

    it("keeps the interval inside its bounds", () => {
        for (const minutes of [0.1, 1, 10, 120, 600]) {
            const { intervalMs } = spriteLayout(minutes * 60_000);

            expect(intervalMs).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
            expect(intervalMs).toBeLessThanOrEqual(MAX_INTERVAL_MS);
        }
    });

    it("samples a short clip finely and a long film coarsely", () => {
        expect(spriteLayout(60_000).intervalMs).toBe(MIN_INTERVAL_MS);
        expect(spriteLayout(3 * 3_600_000).intervalMs).toBeGreaterThan(MIN_INTERVAL_MS);
    });

    it("still produces a layout for an unprobed or zero-length file", () => {
        // The scrubber degrades to one thumbnail rather than crashing.
        for (const duration of [null, 0, -1]) {
            expect(spriteLayout(duration).tileCount).toBe(1);
            expect(spriteLayout(duration).sheetCount).toBe(1);
        }
    });

    it("never claims more tiles than the video has intervals", () => {
        const layout = spriteLayout(10_000);

        // `fps=1/N` emits at 0, N, 2N…, so a 10s video at 2s intervals has 5 frames, not 6.
        expect(layout.tileCount).toBe(5);
    });
});

describe("formatVttTimestamp", () => {
    it("always writes hours, zero-padded", () => {
        expect(formatVttTimestamp(0)).toBe("00:00:00.000");
        expect(formatVttTimestamp(1_500)).toBe("00:00:01.500");
        expect(formatVttTimestamp(3_661_234)).toBe("01:01:01.234");
    });

    it("clamps a negative to zero rather than emitting an unparseable cue", () => {
        expect(formatVttTimestamp(-5)).toBe("00:00:00.000");
    });

    it("round-trips through the parser", () => {
        for (const ms of [0, 1, 999, 1_000, 59_999, 3_600_000, 12_345_678]) {
            expect(parseVttTimestamp(formatVttTimestamp(ms))).toBe(ms);
        }
    });
});

describe("parseVttTimestamp", () => {
    it("accepts the optional hours field", () => {
        expect(parseVttTimestamp("01:02.500")).toBe(62_500);
        expect(parseVttTimestamp("00:01:02.500")).toBe(62_500);
    });

    it("rejects nonsense rather than returning a plausible number", () => {
        for (const value of ["", "abc", "1:2", "00:00:00", "--\x3e"]) {
            expect(parseVttTimestamp(value)).toBeNull();
        }
    });
});

const layoutFor = (durationMs: number) => ({
    layout: spriteLayout(durationMs),
    durationMs,
    tileWidth: 200,
    tileHeight: 112,
    sheetUrl: (ordinal: number) => `/api/art/abc/sprite-${ordinal}`,
});

describe("buildSpriteVtt", () => {
    it("writes one cue per tile, in order, covering the whole video", () => {
        const input = layoutFor(600_000);
        const cues = parseSpriteVtt(buildSpriteVtt(input));

        expect(cues).toHaveLength(input.layout.tileCount);
        expect(cues[0].startMs).toBe(0);
        expect(cues[cues.length - 1].endMs).toBe(600_000);

        for (let i = 1; i < cues.length; i += 1) {
            // No gaps and no overlaps: every moment maps to exactly one thumbnail.
            expect(cues[i].startMs).toBe(cues[i - 1].endMs);
        }
    });

    it("lays tiles out row-major and wraps onto the next sheet", () => {
        // Two hours, so the interval is at its ceiling and there is genuinely a second sheet —
        // anything shorter now fits in one, and the wrap would go untested.
        const cues = parseSpriteVtt(buildSpriteVtt(layoutFor(7_200_000)));

        expect(cues[0]).toMatchObject({ x: 0, y: 0, url: "/api/art/abc/sprite-0" });
        expect(cues[1]).toMatchObject({ x: 200, y: 0 });
        // The end of the first row wraps down, not across.
        expect(cues[SPRITE_COLUMNS]).toMatchObject({ x: 0, y: 112 });

        expect(cues.length).toBeGreaterThan(TILES_PER_SHEET);

        // The first tile of the second sheet starts back at the origin of a new image.
        expect(cues[TILES_PER_SHEET]).toMatchObject({
            x: 0,
            y: 0,
            url: "/api/art/abc/sprite-1",
        });
    });

    it("never runs a cue past the end of the video", () => {
        // The last interval is usually partial; a cue extending beyond the duration makes the
        // scrubber's final thumbnail unreachable.
        for (const duration of [10_500, 61_000, 3_601_000]) {
            const cues = parseSpriteVtt(buildSpriteVtt(layoutFor(duration)));

            expect(cues[cues.length - 1].endMs).toBeLessThanOrEqual(duration);
        }
    });

    it("produces a track the parser reads back identically", () => {
        const vtt = buildSpriteVtt(layoutFor(120_000));

        expect(vtt.startsWith("WEBVTT")).toBe(true);
        expect(parseSpriteVtt(vtt)).toEqual(parseSpriteVtt(vtt));
    });
});

describe("parseSpriteVtt", () => {
    it("skips a malformed cue instead of failing the whole track", () => {
        // Most of the thumbnails beats none of them.
        const vtt = [
            "WEBVTT",
            "",
            "1",
            "00:00:00.000 --> 00:00:02.000",
            "/api/art/abc/sprite-0#xywh=0,0,200,112",
            "",
            "2",
            "garbled",
            "/api/art/abc/sprite-0#xywh=200,0,200,112",
            "",
            "3",
            "00:00:04.000 --> 00:00:06.000",
            "/api/art/abc/sprite-0",
            "",
            "4",
            "00:00:06.000 --> 00:00:08.000",
            "/api/art/abc/sprite-0#xywh=400,0,200,112",
            "",
        ].join("\n");

        const cues = parseSpriteVtt(vtt);

        expect(cues).toHaveLength(2);
        expect(cues[1].startMs).toBe(6_000);
    });

    it("returns nothing for an empty or non-VTT input", () => {
        expect(parseSpriteVtt("")).toEqual([]);
        expect(parseSpriteVtt("not a vtt file at all")).toEqual([]);
    });
});

describe("cueAt", () => {
    const cues = parseSpriteVtt(buildSpriteVtt(layoutFor(600_000)));

    it("finds the cue covering a moment", () => {
        expect(cueAt(cues, 0)).toBe(cues[0]);
        expect(cueAt(cues, cues[5].startMs + 1)).toBe(cues[5]);
        expect(cueAt(cues, cues[5].endMs)).toBe(cues[6]);
    });

    it("clamps past the end rather than returning nothing", () => {
        // The pointer reaching the very end of the scrubber is the normal case, not an edge.
        expect(cueAt(cues, 600_000)).toBe(cues[cues.length - 1]);
        expect(cueAt(cues, 999_999_999)).toBe(cues[cues.length - 1]);
    });

    it("handles an empty track", () => {
        expect(cueAt([], 1000)).toBeNull();
    });

    it("agrees with a linear scan at every boundary", () => {
        // The binary search runs on every pointer move; an off-by-one here shows up as a
        // thumbnail that lags the cursor by one tile, which is easy to miss and maddening.
        for (const cue of cues) {
            expect(cueAt(cues, cue.startMs)).toBe(cue);
            expect(cueAt(cues, cue.endMs - 1)).toBe(cue);
        }
    });
});

describe("spriteTileAt", () => {
    // Long enough to need several sheets, so the sheet number is exercised too.
    const input = layoutFor(4 * 60 * 60 * 1000);
    const cues = parseSpriteVtt(buildSpriteVtt(input));
    const tileAt = (atMs: number) =>
        spriteTileAt(atMs, input.layout, input.tileWidth, input.tileHeight);

    it("picks the same tile the scrubber's track names for every moment", () => {
        // The OCR review page draws this tile beside a string. If it disagreed with the VTT,
        // the picture shown would not be the frame the text was read from.
        for (const cue of cues) {
            for (const atMs of [cue.startMs, cue.endMs - 1]) {
                const tile = tileAt(atMs);

                expect(cue.url).toBe(`/api/art/abc/sprite-${tile.sheet}`);
                expect([cue.x, cue.y]).toEqual([tile.x, tile.y]);
            }
        }
    });

    it("clamps a moment outside the video onto the first or last tile", () => {
        const last = cues[cues.length - 1];

        expect(tileAt(-500)).toEqual({ sheet: 0, x: 0, y: 0 });
        expect([tileAt(999_999_999).x, tileAt(999_999_999).y]).toEqual([last.x, last.y]);
    });
});
