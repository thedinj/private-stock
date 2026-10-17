import { describe, expect, it } from "vitest";

import { buildSegmentPlaylist, parseKeyframes, type SegmentIndex } from "./segments.js";

describe("parseKeyframes", () => {
    it("keeps keyframes only, in milliseconds", () => {
        expect(
            parseKeyframes(["1.466667,564,K_", "1.5,9000,__", "", "4.466667,378820,K_"].join("\n"))
        ).toEqual([
            [1466.667, 564],
            [4466.667, 378820],
        ]);
    });

    it("drops packets without a time or a position, and anything stepping backwards", () => {
        expect(
            parseKeyframes(
                [
                    "1,100,K_",
                    "N/A,200,K_",
                    "2,N/A,K_",
                    "3,50,K_",
                    "0.5,400,K_",
                    "4,400,K_",
                    "\r",
                ].join("\n")
            )
        ).toEqual([
            [1000, 100],
            [4000, 400],
        ]);
    });
});

/** Seven keyframes three seconds apart, starting late as a TS clock does. */
const index: SegmentIndex = {
    version: 1,
    sizeBytes: 10_000,
    mtimeMs: 0,
    durationMs: 21_000,
    keyframes: [
        [1500, 564],
        [4500, 1500],
        [7500, 3000],
        [10500, 4500],
        [13500, 6000],
        [16500, 7500],
        [19500, 9000],
    ],
};

const segmentsOf = (playlist: string) => {
    const lines = playlist.split("\n");

    return lines.flatMap((line, i) =>
        line.startsWith("#EXTINF:")
            ? [
                  {
                      seconds: Number(line.slice(8, -1)),
                      range: lines[i + 1].replace("#EXT-X-BYTERANGE:", ""),
                      uri: lines[i + 2],
                  },
              ]
            : []
    );
};

describe("buildSegmentPlaylist", () => {
    it("covers every byte exactly once, from the start of the file to its end", () => {
        const segments = segmentsOf(buildSegmentPlaylist(index, "stream?raw=1"));
        let expected = 0;

        for (const { range } of segments) {
            const [length, offset] = range.split("@").map(Number);

            expect(offset).toBe(expected);
            expected = offset + length;
        }

        expect(expected).toBe(index.sizeBytes);
    });

    it("groups keyframes into segments of a few seconds, summing to the duration", () => {
        const segments = segmentsOf(buildSegmentPlaylist(index, "stream?raw=1"));

        expect(segments.map((segment) => segment.seconds)).toEqual([6, 6, 6, 3]);
        expect(segments.every((segment) => segment.uri === "stream?raw=1")).toBe(true);
    });

    it("declares a target duration no segment exceeds, and ends the list", () => {
        const playlist = buildSegmentPlaylist(index, "x");

        expect(playlist).toContain("#EXT-X-TARGETDURATION:6");
        expect(playlist).toContain("#EXT-X-VERSION:4");
        expect(playlist.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
    });

    it("plays a file with a single keyframe as one segment", () => {
        const segments = segmentsOf(
            buildSegmentPlaylist({ ...index, keyframes: [[1500, 564]] }, "x")
        );

        expect(segments).toEqual([{ seconds: 21, range: "10000@0", uri: "x" }]);
    });
});
