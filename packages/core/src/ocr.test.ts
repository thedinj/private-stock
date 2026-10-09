import { describe, expect, it } from "vitest";

import {
    boxOverlap,
    electText,
    isWorthStoring,
    keepReviewed,
    ocrFramePlan,
    OCR_MAX_FRAMES,
    OCR_PROBE_FRAMES,
    foldForComparison,
    normalizeText,
    reconcileText,
    similarity,
    type TextObservation,
} from "./ocr.js";

/**
 * Reconciling what many frames said (§5d).
 *
 * This is the part of OCR that is actually hard, and it is pure, so it is tested against
 * fixtures that state exactly what the frames reported. The failure it exists to prevent is
 * quiet: a watermark read three different ways becomes three rows, each with a third of the
 * occurrences, and the recurrence signal the whole design leans on disappears without any
 * error at all.
 */

const WATERMARK = { x: 0.7, y: 0.9, w: 0.28, h: 0.06 };
const TITLE_CARD = { x: 0.2, y: 0.4, w: 0.6, h: 0.15 };

const seen = (text: string, atMs: number, confidence = 0.9, box = WATERMARK): TextObservation => ({
    text,
    atMs,
    confidence,
    box,
});

describe("folding for comparison", () => {
    it("treats the glyphs recognition confuses as the same", () => {
        // The exact failure that made exact-match collapsing wrong.
        expect(foldForComparison("PRIVATE STOCK")).toBe(foldForComparison("PRIVATE ST0CK"));
        expect(foldForComparison("PRIVATE STOCK")).toBe(foldForComparison("PRlVATE STOCK"));
        expect(foldForComparison("1080p")).toBe(foldForComparison("l08Op"));
    });

    it("never leaks into what gets stored", () => {
        // Folding is a claim about what the engine gets wrong, not about what the text says.
        // Applied to the output it would corrupt a URL or a serial number.
        expect(normalizeText("PRIVATE ST0CK")).toBe("private st0ck");
        expect(normalizeText("Visit  EXAMPLE.com ")).toBe("visit example.com");
    });
});

describe("box overlap", () => {
    it("is 1 for the same box and 0 for disjoint ones", () => {
        expect(boxOverlap(WATERMARK, WATERMARK)).toBeCloseTo(1);
        expect(boxOverlap(WATERMARK, TITLE_CARD)).toBe(0);
    });

    it("survives a small drift", () => {
        // A watermark is not pixel-identical between frames; grouping must not require it.
        expect(boxOverlap(WATERMARK, { ...WATERMARK, x: 0.71 })).toBeGreaterThan(0.8);
    });
});

describe("similarity", () => {
    it("is relative to length, so short strings are judged strictly", () => {
        // One wrong character in four is a different word; one in twenty is a misreading.
        expect(similarity("abcd", "abce")).toBeLessThan(0.8);
        expect(similarity("a much longer string", "a much longer strinq")).toBeGreaterThan(0.9);
    });
});

describe("electing a reading", () => {
    it("can produce a string no single frame reported", () => {
        // The entire reason for sampling more than one frame: each reading is wrong in a
        // different place, so at every position the majority is right even though no whole
        // reading is.
        const readings = ["PRlVATE STOCK", "PRIVATE ST0CK", "FRIVATE STOCK"];
        const elected = electText(readings.map((text, i) => seen(text, i * 1000)));

        expect(elected.text).toBe("PRIVATE STOCK");
        expect(readings).not.toContain(elected.text);
    });

    it("follows the majority even when the majority is wrong", () => {
        // The honest limit of voting, and worth stating rather than discovering: it
        // recovers the truth when misreadings are *distributed*, and cannot when most
        // frames are wrong the same way. Two readings with `0` outvote one with `O`,
        // because from here that is indistinguishable from two being right.
        const elected = electText([
            seen("PRIVATE ST0CK", 1000),
            seen("PRIVATE ST0CK", 2000),
            seen("PRIVATE STOCK", 3000),
        ]);

        expect(elected.text).toBe("PRIVATE ST0CK");
    });

    it("weighs a confident reading more heavily than a doubtful one", () => {
        const elected = electText([
            seen("STOCK", 1000, 0.95),
            seen("ST0CK", 2000, 0.3),
            seen("ST0CK", 3000, 0.3),
        ]);

        // Two votes for the wrong character, one confident vote for the right one. Counting
        // heads would lose this; weighting does not.
        expect(elected.text).toBe("STOCK");
    });

    it("takes the best single reading when there is nothing to corroborate", () => {
        // Below the vote threshold a "consensus" is one or two frames agreeing with
        // themselves, which is not evidence of anything.
        const elected = electText([seen("ST0CK", 1000, 0.4), seen("STOCK", 2000, 0.8)]);

        expect(elected.text).toBe("STOCK");
        expect(elected.confidence).toBe(0.8);
    });

    it("lets a dropped character count without letting it vote", () => {
        const elected = electText([
            seen("PRIVATE STOCK", 1000),
            seen("PRIVATE STOCK", 2000),
            seen("RIVATE STOCK", 3000),
            seen("PRIVATE ST0CK", 4000),
        ]);

        // Aligning different lengths needs a full alignment pass and the common case does
        // not call for one: jitter substitutes far more often than it drops. The short
        // reading is still an occurrence; it just has no say in the spelling.
        expect(elected.text).toBe("PRIVATE STOCK");
    });
});

describe("deciding what is worth a row", () => {
    const finding = (confidence: number, occurrences: number, stability: number) => ({
        text: "EXAMPLE.COM",
        textNorm: "example.com",
        firstAtMs: 0,
        lastAtMs: 1000,
        confidence,
        occurrences,
        stability,
        box: WATERMARK,
    });

    it("keeps every finding a person confirmed was real", () => {
        // The four rows read off a real library by somebody who could see the frames. They
        // are the only evidence there is about where this floor belongs, so they are the
        // test: a change that drops one of these is wrong however reasonable it sounds.
        expect(isWorthStoring(finding(0.54, 2, 0.29))).toBe(true);
        expect(isWorthStoring(finding(0.92, 10, 0.23))).toBe(true);
        expect(isWorthStoring(finding(0.92, 16, 0.38))).toBe(true);
        expect(isWorthStoring(finding(0.92, 33, 0.79))).toBe(true);
    });

    it("refuses a reading no second frame ever saw", () => {
        // 85% of everything recognised on a real library appeared in exactly one frame. One
        // frame is not corroboration, and corroboration is the argument this whole feature
        // rests on -- a confident single reading of a texture is still a reading of a
        // texture.
        expect(isWorthStoring(finding(0.97, 1, 0.03))).toBe(false);
    });

    it("does not judge a finding by how long its file is", () => {
        // The same evidence, on a seven-frame item and on a feature. Stability separates a
        // watermark from a title card and belongs in ranking; it cannot decide whether a row
        // exists, or identical findings would be catalogued or discarded according to the
        // runtime of the thing they were found in.
        expect(isWorthStoring(finding(0.6, 2, 0.29))).toBe(true);
        expect(isWorthStoring(finding(0.6, 2, 0.005))).toBe(true);
    });
});

describe("reconciling a whole item", () => {
    it("makes one row out of a watermark read many ways", () => {
        const rows = reconcileText(
            [
                seen("PRIVATE STOCK", 1000),
                seen("PRIVATE ST0CK", 60_000),
                seen("PRlVATE STOCK", 120_000),
                seen("PRIVATE STOCK", 180_000),
            ],
            4
        );

        // The bug this module exists to prevent: four rows, each claiming one occurrence,
        // and a recurrence signal split across an object's own misreadings.
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("PRIVATE STOCK");
        expect(rows[0].occurrences).toBe(4);
        expect(rows[0].stability).toBe(1);
        expect(rows[0].firstAtMs).toBe(1000);
        expect(rows[0].lastAtMs).toBe(180_000);
    });

    it("keeps different text in the same corner apart", () => {
        // Position is the first grouping key, so without the similarity check a rotating
        // caption in one spot would collapse into a single meaningless string.
        const rows = reconcileText(
            [seen("SCENE ONE", 1000), seen("SCENE ONE", 2000), seen("CLOSING CREDITS", 300_000)],
            3
        );

        expect(rows.map((row) => row.text).sort()).toEqual(["CLOSING CREDITS", "SCENE ONE"]);
    });

    it("keeps the same text in different places apart", () => {
        // Two objects, not one: a title card that happens to repeat the site name is a
        // different piece of evidence from the watermark, and it has a different timestamp.
        const rows = reconcileText(
            [
                seen("EXAMPLE", 1000, 0.9, WATERMARK),
                seen("EXAMPLE", 2000, 0.9, WATERMARK),
                seen("EXAMPLE", 1000, 0.9, TITLE_CARD),
            ],
            2
        );

        expect(rows).toHaveLength(2);
    });

    it("separates a persistent watermark from a title card by stability", () => {
        const rows = reconcileText(
            [
                ...Array.from({ length: 18 }, (_, i) => seen("EXAMPLE.COM", i * 60_000)),
                seen("A FILM BY SOMEBODY", 2000, 0.9, TITLE_CARD),
                seen("A FILM BY SOMEBODY", 4000, 0.9, TITLE_CARD),
            ],
            20
        );

        const [first, second] = rows;

        // Sorted by stability, so the site identity leads. High and fixed is a watermark;
        // low and early is a card — derivable from what is stored, so neither is recorded
        // as a judgement.
        expect(first.text).toBe("EXAMPLE.COM");
        expect(first.stability).toBeCloseTo(0.9);
        expect(second.stability).toBeCloseTo(0.1);
        expect(second.firstAtMs).toBeLessThan(10_000);
    });

    it("reports stability against frames examined, not frames that found text", () => {
        // The denominator has to be every frame looked at. Counting only the ones that
        // produced text would make every string in a mostly-blank file look persistent.
        const rows = reconcileText([seen("EXAMPLE", 1000), seen("EXAMPLE", 2000)], 40);

        expect(rows[0].stability).toBeCloseTo(0.05);
    });

    it("drops strings too short to be anybody's metadata", () => {
        // Measured, not guessed: on a real library three quarters of everything recognised
        // was one or two characters -- fragments of graphics and compression artefacts.
        // Burned-in metadata is essentially never that short, so this removes most of the
        // noise before any other threshold is consulted.
        const rows = reconcileText(
            [
                seen("W", 1000),
                seen("=4", 2000),
                seen("gin", 3500),
                ...Array.from({ length: 4 }, (_, i) => seen("AURORA", i * 1000, 0.9, TITLE_CARD)),
            ],
            6
        );

        expect(rows.map((row) => row.text)).toEqual(["AURORA"]);
    });

    it("judges length after the vote, not before it", () => {
        // A short misreading of a real word belongs in the vote that corrects it. Filtering
        // observations first would drop the very readings that corroborate.
        const rows = reconcileText(
            [seen("ITV1", 1000, 0.9), seen("ITV", 2000, 0.4), seen("ITV1", 3000, 0.9)],
            3
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("ITV1");
        expect(rows[0].occurrences).toBe(3);
    });

    it("absorbs a fragment into the string it is a fragment of", () => {
        // Recognition routinely reports both the whole watermark and the piece it managed
        // on a worse frame. They are one object read twice, and reporting both makes the
        // fragment compete with the real string while splitting the evidence.
        const whole = { x: 0.6, y: 0.9, w: 0.3, h: 0.05 };
        const part = { x: 0.72, y: 0.9, w: 0.18, h: 0.05 };

        const rows = reconcileText(
            [
                seen("example-site.com", 1000, 0.9, whole),
                seen("example-site.com", 2000, 0.9, whole),
                seen("ite.com", 3000, 0.6, part),
            ],
            3
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("example-site.com");
        // The union of the frames, not the sum: both were read from frames of one file, and
        // adding the counts would claim more corroboration than exists.
        expect(rows[0].occurrences).toBe(3);
    });

    it("lets a fragment corroborate without letting it respell the string", () => {
        // The failure absorption actually produced on a real file, and the opposite of what
        // it was written to do. A watermark that is only sometimes read in full is read in
        // part more often than in full, so the fragments arrive as the *majority*: merged in
        // as voters they carry the modal length and elect themselves, and the rule meant to
        // protect the whole string is what destroys it.
        const whole = { x: 0.05, y: 0.05, w: 0.3, h: 0.05 };
        const part = { x: 0.21, y: 0.05, w: 0.12, h: 0.05 };

        const rows = reconcileText(
            [
                seen("example-site.com", 1000, 0.9, whole),
                seen("example-site.com", 2000, 0.9, whole),
                seen("ite.com", 3000, 0.6, part),
                seen("ite.com", 4000, 0.6, part),
                seen("ite.com", 5000, 0.6, part),
                seen("ite.com", 6000, 0.6, part),
            ],
            6
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("example-site.com");
        // Every frame still counts towards the recurrence argument -- the fragment is
        // evidence the object was there, just not evidence of how it is spelled.
        expect(rows[0].occurrences).toBe(6);
        expect(rows[0].stability).toBe(1);
    });

    it("can be asked to leave fragments alone, so the rule can be measured", () => {
        // Absorption is a judgement about what recognition does, not a fact about it. The
        // switch is what lets a real library be surveyed with it on and off in the same run
        // -- otherwise a rule that quietly costs a detection is indistinguishable from one
        // that removes noise, since both simply produce fewer rows.
        const whole = { x: 0.6, y: 0.9, w: 0.3, h: 0.05 };
        const part = { x: 0.72, y: 0.9, w: 0.18, h: 0.05 };

        const observations = [
            seen("example-site.com", 1000, 0.9, whole),
            seen("example-site.com", 2000, 0.9, whole),
            seen("ite.com", 3000, 0.6, part),
        ];

        expect(reconcileText(observations, 3, { absorb: false })).toHaveLength(2);
        expect(reconcileText(observations, 3)).toHaveLength(1);
    });

    it("keeps a short string that is not part of anything else", () => {
        const rows = reconcileText(
            [
                seen("ITV1", 1000, 0.9, TITLE_CARD),
                seen("ITV1", 2000, 0.9, TITLE_CARD),
                seen("example-site.com", 1000, 0.9),
            ],
            2
        );

        // Absorption is about fragments in the same place, not about short strings in
        // general -- a channel identifier is exactly what this is meant to find.
        expect(rows.map((row) => row.text).sort()).toEqual(["ITV1", "example-site.com"]);
    });

    it("drops readings that are only punctuation", () => {
        // Stray marks and compression artefacts read as text. There is nothing to match and
        // nothing worth indexing.
        expect(reconcileText([seen("...", 1000), seen("-- .", 2000)], 2)).toEqual([]);
    });

    it("follows a watermark that drifts rather than splitting it in two", () => {
        // A box that moves a little each frame must not walk out of its own cluster: the
        // running box follows the members it has already taken.
        const rows = reconcileText(
            Array.from({ length: 8 }, (_, i) =>
                seen("EXAMPLE.COM", i * 1000, 0.9, { ...WATERMARK, x: 0.7 + i * 0.004 })
            ),
            8
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].occurrences).toBe(8);
    });

    it("has nothing to say about a file with no text in it", () => {
        expect(reconcileText([], 6)).toEqual([]);
    });
});

describe("planning which frames to read", () => {
    it("spends almost nothing on an item until something is found", () => {
        // The probe is the exit for the majority of a library and the largest cost decision
        // in the feature: six frames rather than sixty, on every file that carries no text.
        const plan = ocrFramePlan(7_200_000);

        expect(plan.probe).toHaveLength(OCR_PROBE_FRAMES);
    });

    it("looks in the opening and in the body, not only at the start", () => {
        const plan = ocrFramePlan(7_200_000);

        // A title card is at the front, so half the probe is there. But a file whose only
        // text is a watermark must not be eliminated for having an unmarked first minute.
        expect(plan.probe.filter((at) => at <= 30_000).length).toBeGreaterThanOrEqual(3);
        expect(plan.probe.filter((at) => at > 60_000).length).toBeGreaterThanOrEqual(2);
    });

    it("never plans more frames than the cap", () => {
        for (const duration of [10_000, 120_000, 3_600_000, 7_200_000, 36_000_000]) {
            const plan = ocrFramePlan(duration);
            const total = plan.probe.length + plan.burst.length + plan.sweep.length;

            // The cap is on frames read, so a plan that promised more would have the handler
            // stop in the middle of a pass -- which is the one place the sampling stops being
            // the thing that was reasoned about.
            expect(total).toBeLessThanOrEqual(OCR_MAX_FRAMES);
        }
    });

    it("leaves the sweep enough of the budget to cross a feature", () => {
        const plan = ocrFramePlan(7_200_000);

        // The burst and the sweep compete for the same cap, and the burst is dense. A window
        // wide enough to swallow the budget would leave a two-hour film with almost no
        // coverage of the hours where a watermark actually is.
        expect(plan.sweep.length).toBeGreaterThanOrEqual(10);
    });

    it("reads a still once and has no later passes to run", () => {
        // No timeline, one frame. Sampling is a claim about time passing.
        expect(ocrFramePlan(null)).toEqual({ probe: [0], burst: [], sweep: [] });
    });

    it("never plans a position past the end of the item", () => {
        const plan = ocrFramePlan(9_000);

        for (const at of [...plan.probe, ...plan.burst, ...plan.sweep]) {
            expect(at).toBeLessThan(9_000);
        }
    });

    it("does not read the same moment twice across passes", () => {
        const plan = ocrFramePlan(600_000);
        const all = [...plan.probe, ...plan.burst, ...plan.sweep];

        // Overlap would inflate the occurrence count of whatever is on screen at that moment,
        // which is the number every later decision is made on.
        expect(new Set(all).size).toBe(all.length);
    });
});

/**
 * A re-run must not bring back what somebody already decided about (§5d). Too strict and a
 * dismissed watermark reappears; too loose and genuinely new text is thrown away.
 */
describe("keepReviewed", () => {
    const corner = { x: 0.8, y: 0.9, w: 0.15, h: 0.05 };
    const centre = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    const finding = (text: string, box: typeof corner | null = corner) => ({ text, box });

    it("keeps everything when nothing has been reviewed", () => {
        expect(keepReviewed([finding("SITE.COM")], [])).toHaveLength(1);
    });

    it("drops a reading of the same text, wherever it is", () => {
        const reviewed = [{ text: "site.com", originalText: null, box: centre }];

        expect(keepReviewed([finding("SITE.COM")], reviewed)).toEqual([]);
    });

    it("drops the misreading somebody already corrected", () => {
        // Corrected to "SITE.COM"; the engine reads "S1TE.C0M" again on the re-run.
        const reviewed = [{ text: "SITE.COM", originalText: "S1TE.C0M", box: corner }];

        expect(keepReviewed([finding("S1TE.C0M")], reviewed)).toEqual([]);
    });

    it("drops a slightly different misreading in the same place", () => {
        const reviewed = [{ text: "WATERMARK", originalText: null, box: corner }];

        expect(keepReviewed([finding("WATERMAPK")], reviewed)).toEqual([]);
    });

    it("keeps different text in the same place", () => {
        // A caption can share a corner with the watermark it replaced.
        const reviewed = [{ text: "WATERMARK", originalText: null, box: corner }];

        expect(keepReviewed([finding("Episode twelve")], reviewed)).toHaveLength(1);
    });

    it("keeps similar text somewhere else", () => {
        const reviewed = [{ text: "WATERMARK", originalText: null, box: corner }];

        expect(keepReviewed([finding("WATERMAPK", centre)], reviewed)).toHaveLength(1);
    });

    it("matches on text alone when either side has no box", () => {
        const reviewed = [{ text: "WATERMARK", originalText: null, box: null }];

        expect(keepReviewed([finding("WATERMARK", null)], reviewed)).toEqual([]);
        expect(keepReviewed([finding("WATERMAPK", null)], reviewed)).toHaveLength(1);
    });
});
