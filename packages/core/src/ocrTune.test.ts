import { describe, expect, it } from "vitest";

import { ocrSettingsSchema, ocrTestSetSchema } from "./ocrSettings.js";
import {
    pickCandidates,
    recognitionGrid,
    samplingGrid,
    scoreVideo,
    totalScore,
    type TuneCandidate,
} from "./ocrTune.js";

/**
 * Scoring settings against what an administrator says a video should yield (§5d "Tuning
 * against expected text"). The tuner optimises whatever this rewards, so each rule here is a
 * statement about what good OCR is.
 */
describe("scoring a video", () => {
    it("credits a banner read word by word, as sparse mode returns it", () => {
        const score = scoreVideo(["DON'T", "'FALL", "THROUGH!"], {
            expected: ["DON'T FALL THROUGH!"],
            complete: false,
        });

        expect(score.hits).toEqual([{ expected: "DON'T FALL THROUGH!", coverage: 1 }]);
        expect(score.misses).toEqual([]);
    });

    it("gives a near reading most of the credit, and an exact one all of it", () => {
        const near = scoreVideo(["ELIMINATFD"], { expected: ["ELIMINATED"], complete: false });
        const exact = scoreVideo(["Eliminated"], { expected: ["ELIMINATED"], complete: false });

        expect(near.points).toBeCloseTo(0.7);
        expect(exact.points).toBe(1);
    });

    it("credits part of a phrase for the words it read", () => {
        const score = scoreVideo(["THROUGH!"], {
            expected: ["DON'T FALL THROUGH!"],
            complete: false,
        });

        expect(score.points).toBeCloseTo(1 / 3);
    });

    it("lists what was expected and not read at all", () => {
        expect(
            scoreVideo(["HELP"], { expected: ["ELIMINATED", "HELP"], complete: false }).misses
        ).toEqual(["ELIMINATED"]);
    });

    it("calls unexpected text junk only where the administrator said the list is complete", () => {
        const found = ["ELIMINATED", "x1lj"];
        const partial = scoreVideo(found, { expected: ["ELIMINATED"], complete: false });
        const complete = scoreVideo(found, { expected: ["ELIMINATED"], complete: true });

        expect(partial).toMatchObject({ unexpected: ["x1lj"], junk: [] });
        expect(complete).toMatchObject({ unexpected: ["x1lj"], junk: ["x1lj"] });
    });
});

describe("scoring a run", () => {
    const video = (points: number, junk: string[], foundCount: number, framesRead: number) => ({
        score: { hits: [], misses: [], unexpected: junk, junk, points },
        truth: { expected: ["ONE", "TWO"], complete: true },
        foundCount,
        framesRead,
    });

    it("weighs recall against junk and against frames beyond the current settings'", () => {
        const same = totalScore([video(2, [], 2, 30)], 30, "medium");
        const junky = totalScore([video(2, ["x"], 3, 30)], 30, "medium");
        const costly = totalScore([video(2, [], 2, 60)], 30, "medium");

        expect(same).toMatchObject({ recall: 1, junkRate: 0, frameRatio: 1, score: 1 });
        expect(junky.score).toBeLessThan(same.score);
        expect(costly.score).toBeLessThan(same.score);
        // Cost matters more when the administrator says it does.
        expect(totalScore([video(2, [], 2, 60)], 30, "high").score).toBeLessThan(costly.score);
    });
});

describe("noise on a partly labelled video", () => {
    const partly = (unexpected: number, found: number) => ({
        score: {
            hits: [],
            misses: [],
            unexpected: Array.from({ length: unexpected }, (_, index) => `x${index}`),
            junk: [],
            points: 1,
        },
        truth: { expected: ["ONE"], complete: false },
        foundCount: found,
        framesRead: 10,
    });

    it("still costs something, at a quarter of the weight", () => {
        // The case that found this: every floor at its minimum, twenty-six fragments read,
        // and nothing to say against it because the video was not marked complete.
        const clean = totalScore([partly(0, 1)], 10, "medium");
        const noisy = totalScore([partly(26, 27)], 10, "medium");

        expect(noisy.junkRate).toBeCloseTo((26 * 0.25) / 27);
        expect(noisy.score).toBeLessThan(clean.score);
    });
});

describe("what is shown", () => {
    const candidate = (recall: number, junkRate: number, frameRatio: number, score: number) =>
        ({
            settings: ocrSettingsSchema.parse({}),
            recall,
            junkRate,
            frameRatio,
            score,
            videos: [],
        }) satisfies TuneCandidate;

    it("picks the most text, the best score, and the same quality for less", () => {
        const baseline = candidate(0.5, 0.1, 1, 0.45);
        const thorough = candidate(0.9, 0.1, 2.5, 0.6);
        const balanced = candidate(0.8, 0.05, 1.2, 0.75);
        const frugal = candidate(0.5, 0.1, 0.6, 0.5);

        const picks = pickCandidates([thorough, balanced, frugal], baseline);

        expect(picks.quality).toBe(thorough);
        expect(picks.balance).toBe(balanced);
        expect(picks.cheapest).toBe(frugal);
    });

    it("does not call a pile of noise the most read", () => {
        const baseline = candidate(0.5, 0, 1, 0.5);
        const noisy = candidate(0.9, 0.8, 1, 0.5);
        const clean = candidate(0.8, 0, 1, 0.8);

        expect(pickCandidates([noisy, clean], baseline).quality).toBe(clean);
    });

    it("keeps the picks apart", () => {
        const baseline = candidate(0.5, 0.1, 1, 0.45);
        const thorough = candidate(0.9, 0.1, 2.5, 0.6);
        const balanced = candidate(0.8, 0.05, 1.2, 0.75);
        const frugal = candidate(0.5, 0.1, 0.6, 0.5);
        const picks = pickCandidates([thorough, balanced, frugal], baseline);

        expect(picks.balance).toBe(balanced);
        expect(picks.cheapest).toBe(frugal);
    });

    it("offers no cheaper option when nothing cheaper is as good", () => {
        const baseline = candidate(0.5, 0, 1, 0.5);

        expect(pickCandidates([candidate(0.4, 0, 0.5, 0.48)], baseline).cheapest).toBeNull();
    });
});

describe("what is searched", () => {
    it("covers every recognition combination once", () => {
        const keys = recognitionGrid().map((config) => JSON.stringify(config));

        expect(keys).toHaveLength(18);
        expect(new Set(keys).size).toBe(18);
    });

    it("only offers sampling the settings would accept", () => {
        for (const sampling of samplingGrid()) {
            expect(ocrSettingsSchema.safeParse(sampling).success).toBe(true);
        }
    });
});

describe("the stored bench", () => {
    it("reads nominations saved before expected text existed", () => {
        expect(
            ocrTestSetSchema.parse(["m1", { mediaId: "m2", expected: ["SITE"], complete: true }])
        ).toEqual([
            { mediaId: "m1", expected: [], complete: false },
            { mediaId: "m2", expected: ["SITE"], complete: true },
        ]);
    });
});
