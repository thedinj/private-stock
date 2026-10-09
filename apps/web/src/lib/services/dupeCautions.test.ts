import { describe, expect, it } from "vitest";

import { groupCautions, type CautionMember } from "./dupeCautions";

/**
 * The rules that decide which duplicate groups start unticked (§10c).
 *
 * Every group without a caution is included when a page is resolved in one press, so a rule
 * that misses is a file trashed on the strength of a glance.
 */

const video = (
    id: string,
    durationMs: number | null,
    coverUrl: string | null = "/c.jpg"
): CautionMember => ({ id, kind: "video", durationMs, coverUrl });

describe("which duplicate groups need a closer look", () => {
    it("flags a short clip grouped with the film it was cut from", () => {
        const cautions = groupCautions(
            "near",
            [video("film", 7_120_000), video("clip", 123_000)],
            "film"
        );

        expect(cautions).toEqual([
            "Lengths differ — 2:03 to 1:58:40. One may be cut from another.",
        ]);
    });

    it("says nothing about 12:00 against 12:04 when the 12:00 copy is kept", () => {
        // Within the tolerance: an intro card, not content, and the ranking was right to
        // prefer the better picture.
        expect(groupCautions("near", [video("a", 720_000), video("b", 724_000)], "a")).toEqual([]);
    });

    it("allows a long video thirty seconds of padding", () => {
        // A studio card or a few seconds of black at each end of a 12-minute video.
        expect(groupCautions("near", [video("a", 720_000), video("b", 750_000)], "a")).toEqual([]);
    });

    it("asks when the recommended copy is shorter than another by more than padding", () => {
        // Picture quality beat 45 seconds of length. Usually an intro; possibly a truncated
        // download, which the thumbnails cannot show.
        expect(groupCautions("near", [video("a", 720_000), video("b", 765_000)], "a")).toEqual([
            "The recommended copy runs 12:00, another 12:45 — check nothing is missing.",
        ]);
    });

    it("keeps a short video to five seconds of padding", () => {
        expect(groupCautions("near", [video("a", 120_000), video("b", 128_000)], "a")).toEqual([
            "The recommended copy runs 2:00, another 2:08 — check nothing is missing.",
        ]);
    });

    it("does not ask when the recommended copy is the longest", () => {
        expect(groupCautions("near", [video("a", 750_000), video("b", 720_000)], "a")).toEqual([]);
    });

    it("does not compare a length it does not know", () => {
        expect(groupCautions("near", [video("a", null), video("b", 600_000)], "a")).toEqual([]);
    });

    it("says how many copies have nothing to look at", () => {
        expect(groupCautions("near", [video("a", 1_000, null), video("b", 1_000)], "a")).toEqual([
            "No picture yet for one of these copies",
        ]);
        expect(
            groupCautions("near", [video("a", 1_000, null), video("b", 1_000, null)], "a")
        ).toEqual(["No picture yet for any of these copies"]);
    });

    it("never cautions about identical files", () => {
        // Same bytes, so the same length and the same frames: a closer look finds nothing.
        expect(
            groupCautions("exact", [video("a", 123_000, null), video("b", 7_120_000)], "a")
        ).toEqual([]);
    });
});
