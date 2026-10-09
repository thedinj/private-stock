import { describe, expect, it } from "vitest";

import { capThreads } from "./ffmpegThreads.js";

/**
 * Where the thread caps land in an ffmpeg argument list.
 *
 * Position is the whole of it: `-threads` means the decoder before an `-i` and the encoder
 * before the output, and a cap in the wrong place is silently a cap on nothing.
 */
describe("capThreads", () => {
    it("caps the filter pools, the decoder and the encoder", () => {
        expect(
            capThreads(["-v", "error", "-i", "in.mp4", "-vf", "scale=200:-2", "out.webp"], 2)
        ).toEqual([
            "-filter_threads",
            "2",
            "-filter_complex_threads",
            "2",
            "-v",
            "error",
            "-threads",
            "2",
            "-i",
            "in.mp4",
            "-vf",
            "scale=200:-2",
            "-threads",
            "2",
            "out.webp",
        ]);
    });

    it("caps every input's decoder, not only the first", () => {
        const capped = capThreads(["-i", "a.mp4", "-i", "b.mp4", "out.mp4"], 1);

        expect(capped.filter((arg) => arg === "-threads")).toHaveLength(3);
        expect(capped.indexOf("a.mp4") - capped.indexOf("-threads")).toBe(3);
    });

    it("keeps input options such as a seek ahead of their input", () => {
        const capped = capThreads(["-ss", "12.000", "-i", "in.mp4", "out.webp"], 1);

        expect(capped.indexOf("-ss")).toBeLessThan(capped.indexOf("-i"));
        expect(capped[capped.indexOf("-i") - 2]).toBe("-threads");
    });

    it("never writes zero, which ffmpeg reads as every core", () => {
        const capped = capThreads(["-i", "in.mp4", "out.webp"], 0);

        expect(capped).not.toContain("0");
        expect(capped[capped.indexOf("-threads") + 1]).toBe("1");
    });
});
