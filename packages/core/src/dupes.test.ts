import { describe, expect, it } from "vitest";

import {
    apartFrom,
    clusterPairs,
    suggestSets,
    verdictsOfSets,
    compareVideos,
    dupeSettingsSchema,
    identicalKeeper,
    planIdentical,
    type IdenticalCopy,
    keepDimension,
    lengthTolerance,
    preferredKeep,
    rankCopies,
    type FrameHash,
    type KeepCandidate,
} from "./dupes.js";
import { PHASH_BYTES, PHASH_MAX_INDEXED_DISTANCE } from "./phash.js";

/**
 * Clustering decides what a person is shown, and preselection decides what they are likely
 * to click. Both fail quietly: a wrong grouping looks like a plausible grouping, and a wrong
 * preselection looks like a reasonable default right up until someone deletes the only 1080p
 * copy of something.
 */

const settings = dupeSettingsSchema.parse({});

/** A hash that differs from a base pattern in exactly `bits` positions. */
const hashWith = (seed: number, bits = 0): Uint8Array => {
    const hash = new Uint8Array(PHASH_BYTES);

    for (let i = 0; i < PHASH_BYTES; i += 1) {
        hash[i] = (seed * 37 + i * 101) & 0xff;
    }

    for (let bit = 0; bit < bits; bit += 1) {
        hash[bit >> 3] ^= 0x80 >> (bit & 7);
    }

    return hash;
};

const frames = (seed: number, count: number, bits = 0): FrameHash[] =>
    Array.from({ length: count }, (_, frameIdx) => ({
        frameIdx,
        hash: hashWith(seed + frameIdx, bits),
    }));

describe("dupeSettingsSchema", () => {
    it("clamps the distance to what the band index can actually find", () => {
        // Above the ceiling the index silently stops returning some genuine pairs rather
        // than slowing down, so a larger number would not widen the net — it would make the
        // results depend on which pairs happened to share a band.
        expect(() => dupeSettingsSchema.parse({ imageDistance: 40 })).toThrow();
        expect(
            dupeSettingsSchema.parse({ imageDistance: PHASH_MAX_INDEXED_DISTANCE }).imageDistance
        ).toBe(PHASH_MAX_INDEXED_DISTANCE);
    });
});

describe("compareVideos", () => {
    it("matches the same video re-encoded", () => {
        const match = compareVideos(frames(1, 10), frames(1, 10, 2), settings);

        expect(match).not.toBeNull();
        expect(match?.matchingFrames).toBe(10);
    });

    it("refuses two videos that merely share a frame", () => {
        // Many videos open on black, close on a logo, or share a stock establishing shot.
        // "Any frame matches" would cluster most of the library into one group.
        const a = frames(1, 10);
        const b = frames(50, 10);

        b[0] = { frameIdx: 0, hash: a[0].hash };

        expect(compareVideos(a, b, settings)).toBeNull();
    });

    it("matches a clip contained in a longer file", () => {
        // Measured against the shorter side: against the longer one the fraction would be
        // a few percent, which no usable threshold separates from coincidence.
        const long = frames(1, 40);
        const clip = long.slice(4, 10);

        const match = compareVideos(clip, long, settings);

        expect(match).not.toBeNull();
        expect(match?.comparedFrames).toBe(clip.length);
    });

    it("pairs each frame at most once", () => {
        /**
         * A locked-off shot produces many near-identical frames. Without one-to-one pairing,
         * every frame on one side matches the same single frame on the other, and the ratio
         * reaches 100% on the strength of one genuine similarity.
         */
        const staticShot: FrameHash[] = Array.from({ length: 10 }, (_, frameIdx) => ({
            frameIdx,
            hash: hashWith(7),
        }));

        const other = frames(90, 10);
        other[0] = { frameIdx: 0, hash: hashWith(7) };

        expect(compareVideos(staticShot, other, settings)).toBeNull();
    });

    it("refuses a pair below the minimum frame count", () => {
        // Two frames agreeing is not evidence, whatever fraction of two frames it is.
        const tiny = frames(1, 2);

        expect(compareVideos(tiny, frames(1, 2, 1), settings)).toBeNull();
    });

    it("returns null rather than throwing when a video has no frames", () => {
        // An unprobed or zero-length file has none, and a clustering pass over the whole
        // library must not abort on one of them.
        expect(compareVideos([], frames(1, 5), settings)).toBeNull();
    });

    it("reports the mean distance over matching frames", () => {
        const match = compareVideos(frames(1, 10), frames(1, 10, 2), settings);

        expect(match?.distance).toBe(2);
    });
});

describe("clusterPairs", () => {
    it("groups a chain of pairs into one cluster", () => {
        const clusters = clusterPairs([
            { a: "a", b: "b", distance: 2 },
            { a: "b", b: "c", distance: 3 },
        ]);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].members).toEqual(["a", "b", "c"]);
    });

    it("keeps unrelated pairs in separate clusters", () => {
        const clusters = clusterPairs([
            { a: "a", b: "b", distance: 1 },
            { a: "c", b: "d", distance: 1 },
        ]);

        expect(clusters).toHaveLength(2);
    });

    it("reports the worst linked distance, so the UI can show how loose a group is", () => {
        const clusters = clusterPairs([
            { a: "a", b: "b", distance: 2 },
            { a: "b", b: "c", distance: 6 },
        ]);

        expect(clusters[0].maxDistance).toBe(6);
    });

    it("produces a stable member order regardless of pair order", () => {
        // A group's identity must not depend on the order rows came back in, or a re-run
        // creates a second group for the same set and the review queue fills with
        // duplicates of duplicates.
        const first = clusterPairs([
            { a: "c", b: "a", distance: 1 },
            { a: "b", b: "c", distance: 1 },
        ]);
        const second = clusterPairs([
            { a: "b", b: "c", distance: 1 },
            { a: "a", b: "c", distance: 1 },
        ]);

        expect(first[0].members).toEqual(second[0].members);
    });

    it("returns nothing for no pairs", () => {
        expect(clusterPairs([])).toEqual([]);
    });

    it("handles a fully connected group without duplicating members", () => {
        const clusters = clusterPairs([
            { a: "a", b: "b", distance: 1 },
            { a: "b", b: "c", distance: 1 },
            { a: "a", b: "c", distance: 1 },
        ]);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].members).toEqual(["a", "b", "c"]);
    });
});

/**
 * Sorting copies apart (§10i). The example the feature was built for: five videos, where A and
 * B are one thing, C and D another, and E a third -- linked into one group by a chain.
 */
describe("clusterPairs with copies kept apart", () => {
    const chain = [
        { a: "A", b: "B", distance: 2 },
        { a: "B", b: "C", distance: 9 },
        { a: "C", b: "D", distance: 3 },
        { a: "D", b: "E", distance: 8 },
    ];
    const sorted = apartFrom(verdictsOfSets([["A", "B"], ["C", "D"], ["E"]]));

    it("keeps a group sorted into sets apart however the chain links it", () => {
        const clusters = clusterPairs(chain, sorted);

        expect(clusters.map((cluster) => cluster.members)).toEqual([
            ["A", "B"],
            ["C", "D"],
        ]);
    });

    it("lets a new copy join the set it is closer to, without tying the sets back together", () => {
        const clusters = clusterPairs(
            [...chain, { a: "X", b: "C", distance: 5 }, { a: "X", b: "A", distance: 1 }],
            sorted
        );

        expect(clusters.map((cluster) => cluster.members)).toEqual([
            ["A", "B", "X"],
            ["C", "D"],
        ]);
    });

    it("does not report the distance of a link it refused", () => {
        const clusters = clusterPairs(chain, sorted);

        expect(clusters.map((cluster) => cluster.maxDistance)).toEqual([2, 3]);
    });

    it("clusters as before when nobody has said anything", () => {
        expect(clusterPairs(chain, new Map())).toEqual(clusterPairs(chain));
    });
});

describe("verdictsOfSets", () => {
    it("says same within a set and different across, once per pair", () => {
        const pairs = verdictsOfSets([["B", "A"], ["C"]]);

        expect(pairs).toEqual([
            { a: "A", b: "B", verdict: "same" },
            { a: "B", b: "C", verdict: "different" },
            { a: "A", b: "C", verdict: "different" },
        ]);
    });
});

describe("suggestSets", () => {
    // Only neighbours in the chain match each other directly.
    const direct = new Set(["A|B", "B|C", "C|D", "D|E"]);
    const matches = (a: string, b: string) => direct.has(`${a}|${b}`) || direct.has(`${b}|${a}`);

    it("splits a chain where its ends do not match", () => {
        expect(suggestSets(["A", "B", "C", "D", "E"], matches)).toEqual([
            ["A", "B"],
            ["C", "D"],
            ["E"],
        ]);
    });

    it("keeps a group whose copies all match as one set", () => {
        expect(suggestSets(["A", "B"], matches)).toEqual([["A", "B"]]);
    });

    it("lets a person's word outweigh the comparison", () => {
        expect(
            suggestSets(["A", "B", "C"], matches, [
                { a: "A", b: "B", verdict: "different" },
                { a: "A", b: "C", verdict: "same" },
                { a: "B", b: "C", verdict: "different" },
            ])
        ).toEqual([["A", "C"], ["B"]]);
    });
});

describe("preferredKeep", () => {
    const candidate = (overrides: Partial<KeepCandidate>): KeepCandidate => ({
        mediaId: "x",
        width: 1920,
        height: 1080,
        bitrate: 5_000_000,
        sizeBytes: 1_000_000_000,
        durationMs: 600_000,
        addedAt: "2024-01-01T00:00:00Z",
        ...overrides,
    });

    it("prefers more pixels", () => {
        const keep = preferredKeep([
            candidate({ mediaId: "hd", width: 1920, height: 1080 }),
            candidate({ mediaId: "sd", width: 1280, height: 720 }),
        ]);

        expect(keep).toBe("hd");
    });

    it("prefers resolution over file size", () => {
        /**
         * The rule most likely to be written by accident, and the most damaging. An
         * inefficiently encoded 720p file is routinely larger than an efficient 1080p one,
         * so ranking by size throws away the better copy surprisingly often.
         */
        const keep = preferredKeep([
            candidate({ mediaId: "hd", width: 1920, height: 1080, sizeBytes: 800_000_000 }),
            candidate({
                mediaId: "bloated-sd",
                width: 1280,
                height: 720,
                sizeBytes: 4_000_000_000,
            }),
        ]);

        expect(keep).toBe("hd");
    });

    it("prefers the longer file when the difference is real", () => {
        // A truncated download and a complete copy look identical apart from length.
        const keep = preferredKeep([
            candidate({ mediaId: "complete", durationMs: 600_000 }),
            candidate({ mediaId: "truncated", durationMs: 120_000 }),
        ]);

        expect(keep).toBe("complete");
    });

    it("ignores a trivial duration difference", () => {
        // Encoders disagree about the last frame. That must not outrank bitrate.
        const keep = preferredKeep([
            candidate({ mediaId: "better", durationMs: 600_000, bitrate: 8_000_000 }),
            candidate({ mediaId: "longer-by-a-second", durationMs: 601_000, bitrate: 2_000_000 }),
        ]);

        expect(keep).toBe("better");
    });

    it("keeps the better picture over a few extra seconds", () => {
        // 12:00 against 12:04 and 12:08: an intro card or a bumper, not content. The goal is
        // the best-looking copy, not the one with the most frames.
        const keep = preferredKeep([
            candidate({ mediaId: "longer-worse", durationMs: 724_000, bitrate: 3_000_000 }),
            candidate({ mediaId: "longest-worse", durationMs: 728_000, bitrate: 3_000_000 }),
            candidate({ mediaId: "better", durationMs: 720_000, bitrate: 8_000_000 }),
        ]);

        expect(keep).toBe("better");
    });

    it("keeps the lower-resolution copy a few seconds longer if resolution says so", () => {
        const keep = preferredKeep([
            candidate({ mediaId: "sd-longer", width: 1280, height: 720, durationMs: 728_000 }),
            candidate({ mediaId: "hd", durationMs: 720_000 }),
        ]);

        expect(keep).toBe("hd");
    });

    it("keeps the whole film over a sharper clip cut from it", () => {
        /**
         * Matching measures against the shorter video, so a clip clusters with its source
         * (§10). Ranking resolution first used to keep the 1080p clip and trash the two-hour
         * film — the worst mistake the review screen could make.
         */
        const keep = preferredKeep([
            candidate({ mediaId: "clip", durationMs: 123_000 }),
            candidate({ mediaId: "film", width: 1280, height: 720, durationMs: 7_120_000 }),
        ]);

        expect(keep).toBe("film");
    });

    it("does not treat an unknown length as a short one", () => {
        const keep = preferredKeep([
            candidate({ mediaId: "unprobed-length", durationMs: null }),
            candidate({ mediaId: "sd", width: 1280, height: 720 }),
        ]);

        expect(keep).toBe("unprobed-length");
    });

    it("falls back to bitrate, then size", () => {
        expect(
            preferredKeep([
                candidate({ mediaId: "low", bitrate: 2_000_000 }),
                candidate({ mediaId: "high", bitrate: 9_000_000 }),
            ])
        ).toBe("high");

        expect(
            preferredKeep([
                candidate({ mediaId: "small", bitrate: null, sizeBytes: 1 }),
                candidate({ mediaId: "big", bitrate: null, sizeBytes: 2 }),
            ])
        ).toBe("big");
    });

    it("breaks a complete tie by age, then id", () => {
        // Deterministic rather than arbitrary: the preselection must not change between two
        // page loads of the same group.
        const keep = preferredKeep([
            candidate({ mediaId: "newer", addedAt: "2024-06-01T00:00:00Z" }),
            candidate({ mediaId: "older", addedAt: "2023-01-01T00:00:00Z" }),
        ]);

        expect(keep).toBe("older");
    });

    it("copes with missing metadata rather than throwing", () => {
        // An unprobed item has no width, height or bitrate at all.
        const keep = preferredKeep([
            candidate({ mediaId: "unprobed", width: null, height: null, bitrate: null }),
            candidate({ mediaId: "probed" }),
        ]);

        expect(keep).toBe("probed");
    });

    it("returns null for an empty group", () => {
        expect(preferredKeep([])).toBeNull();
    });
});

/**
 * The ordering, made inspectable so a screen can argue for it (§10c).
 *
 * The risk these cover is a second implementation: the moment the reason is derived anywhere
 * but from the comparison itself, a card can say "highest resolution" about a copy that won on
 * bitrate — and a recommendation caught lying once is one nobody reads again.
 */
describe("explaining the preference", () => {
    const candidate = (overrides: Partial<KeepCandidate>): KeepCandidate => ({
        mediaId: "x",
        width: 1920,
        height: 1080,
        bitrate: 5_000_000,
        sizeBytes: 1_000_000_000,
        durationMs: 600_000,
        addedAt: "2024-01-01T00:00:00Z",
        ...overrides,
    });

    it("orders the copies best first, and agrees with preferredKeep", () => {
        const copies = [
            candidate({ mediaId: "sd", width: 1280, height: 720 }),
            candidate({ mediaId: "hd" }),
            candidate({ mediaId: "tiny", width: 640, height: 360 }),
        ];

        expect(rankCopies(copies).map((copy) => copy.mediaId)).toEqual(["hd", "sd", "tiny"]);
        expect(preferredKeep(copies)).toBe(rankCopies(copies)[0].mediaId);
    });

    it("leaves the caller's array alone", () => {
        const copies = [
            candidate({ mediaId: "sd", width: 1280, height: 720 }),
            candidate({ mediaId: "hd" }),
        ];

        rankCopies(copies);

        expect(copies.map((copy) => copy.mediaId)).toEqual(["sd", "hd"]);
    });

    it("names the measure that actually separated them", () => {
        expect(keepDimension(candidate({}), candidate({ width: 1280, height: 720 }))).toBe(
            "resolution"
        );
        expect(keepDimension(candidate({}), candidate({ bitrate: 2_000_000 }))).toBe("bitrate");
        expect(keepDimension(candidate({}), candidate({ sizeBytes: 500_000_000 }))).toBe("size");
        expect(keepDimension(candidate({}), candidate({ durationMs: 60_000 }))).toBe("duration");
    });

    /** The tolerance that keeps an encoder's rounding from outranking a resolution gap. */
    it("does not call a two-second difference a difference in length", () => {
        expect(keepDimension(candidate({}), candidate({ durationMs: 598_000 }))).not.toBe(
            "duration"
        );
    });

    it("allows thirty seconds of padding from ten minutes up, five below", () => {
        expect(lengthTolerance(9 * 60_000)).toBe(5_000);
        expect(lengthTolerance(10 * 60_000)).toBe(30_000);
        expect(lengthTolerance(2 * 3_600_000)).toBe(30_000);
    });

    it("names length only for a different cut, not for padding", () => {
        expect(keepDimension(candidate({}), candidate({ durationMs: 590_000 }))).not.toBe(
            "duration"
        );
        expect(keepDimension(candidate({}), candidate({ durationMs: 530_000, width: 3840 }))).toBe(
            "duration"
        );
    });

    it("reports a tie for copies nothing distinguishes", () => {
        expect(keepDimension(candidate({ mediaId: "a" }), candidate({ mediaId: "b" }))).toBe("tie");
    });

    it("names age only when everything that indicates quality is equal", () => {
        expect(
            keepDimension(
                candidate({ mediaId: "a", addedAt: "2023-01-01T00:00:00Z" }),
                candidate({ mediaId: "b" })
            )
        ).toBe("age");
    });
});

describe("trashing every identical copy (§10e)", () => {
    /** Byte-identical, so only age and the root tell them apart. */
    const copy = (id: string, fields: Partial<IdenticalCopy> = {}): IdenticalCopy => ({
        mediaId: id,
        width: 1920,
        height: 1080,
        bitrate: 5_000,
        sizeBytes: 1_000,
        durationMs: 600_000,
        addedAt: `2026-01-0${id.length}T00:00:00Z`,
        deletable: true,
        contentHash: "same",
        clipCount: 0,
        ...fields,
    });

    it("keeps the copy catalogued first and trashes the rest", () => {
        const plan = planIdentical([copy("bb"), copy("a"), copy("ccc")]);

        expect(plan).toEqual({
            kind: "routine",
            keepId: "a",
            trashIds: ["bb", "ccc"],
            bytes: 2_000,
        });
    });

    it("keeps a read-only copy, so the writable ones can go", () => {
        expect(identicalKeeper([copy("a"), copy("bb", { deletable: false })])).toBe("bb");

        expect(planIdentical([copy("a"), copy("bb", { deletable: false })])).toMatchObject({
            kind: "routine",
            keepId: "bb",
            trashIds: ["a"],
        });
    });

    it("has nothing to do when every other copy is read-only", () => {
        expect(
            planIdentical([copy("a", { deletable: false }), copy("bb", { deletable: false })])
        ).toEqual({ kind: "nothing" });
    });

    it("asks a person when a copy that would go has clips on it", () => {
        const plan = planIdentical([copy("a"), copy("bb", { clipCount: 2 })]);

        expect(plan).toEqual({
            kind: "attention",
            reason: "2 clips are cut from a copy that would go",
        });
    });

    it("does not mind clips on the copy that stays", () => {
        expect(planIdentical([copy("a", { clipCount: 3 }), copy("bb")]).kind).toBe("routine");
    });

    it("asks a person when the copies are no longer provably the same bytes", () => {
        expect(planIdentical([copy("a"), copy("bb", { contentHash: null })]).kind).toBe(
            "attention"
        );
        expect(planIdentical([copy("a"), copy("bb", { contentHash: "edited" })]).kind).toBe(
            "attention"
        );
    });
});
