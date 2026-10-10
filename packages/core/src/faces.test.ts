import { describe, expect, it } from "vitest";

import {
    LEGIBLE_EYES,
    appearancesInItem,
    FACE_SIDE,
    alignment,
    chooseFaces,
    decodeFaceGroups,
    encodeFaceGroups,
    decodeDetections,
    detectorLayout,
    eyeDistance,
    groupStateFor,
    autoTagBraked,
    autoTagTrusted,
    autoTags,
    bestMatch,
    decodeFaceAnchors,
    encodeFaceAnchors,
    performerCentre,
    sharedFace,
    peopleInItem,
    placePerson,
    writeDetectorInput,
    writeFaceInput,
    type FaceGroup,
    type Point,
} from "./faces.js";
import { normaliseVector } from "./embedding.js";

const ARCFACE: Point[] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

describe("the detector's input", () => {
    it("scales a tile's long side to 640 and pads only to a multiple of 32", () => {
        expect(detectorLayout(200, 112)).toEqual({ scale: 3.2, width: 640, height: 384 });
        expect(detectorLayout(200, 356)).toMatchObject({ width: 384, height: 640 });
    });

    it("normalises as SCRFD expects, and leaves the padding at zero", () => {
        const rgb = new Uint8Array(4 * 4 * 3).fill(255);
        const layout = { scale: 1, width: 32, height: 32 };
        const out = new Float32Array(3 * 32 * 32);

        writeDetectorInput(rgb, 4, { x: 0, y: 0, width: 4, height: 4 }, layout, out);

        expect(out[0]).toBeCloseTo((255 - 127.5) / 128);
        expect(out[31]).toBe(0);
    });
});

describe("decoding detections", () => {
    // A 64 × 64 input at scale 2: stride 8 is an 8 × 8 grid with two anchors a position.
    const layout = { scale: 2, width: 64, height: 64 };
    const outputs = (): Float32Array[] => {
        const sizes = [8, 16, 32].map((stride) => (64 / stride) ** 2 * 2);

        return [
            ...sizes.map((n) => new Float32Array(n)),
            ...sizes.map((n) => new Float32Array(n * 4)),
            ...sizes.map((n) => new Float32Array(n * 10)),
        ];
    };

    it("places a face from its anchor, in the region's own pixels", () => {
        const out = outputs();
        // Anchor 20 is cell 10: column 2, row 1 of stride 8, so its centre is (16, 8).
        out[0][20] = 0.9;
        out[3].set([1, 1, 1, 1], 20 * 4);
        out[6].set([0.5, 0, 1, 0, 0, 0, 0, 1, 1, 1], 20 * 10);

        const [face, ...rest] = decodeDetections(out, layout);

        expect(rest).toEqual([]);
        expect(face.score).toBeCloseTo(0.9);
        expect(face.box).toEqual({ x: 4, y: 0, width: 8, height: 8 });
        expect(face.landmarks[0]).toEqual([10, 4]);
        expect(face.landmarks[1]).toEqual([12, 4]);
    });

    it("keeps the best of overlapping detections of one face, and drops the unsure", () => {
        const out = outputs();

        out[0][20] = 0.9;
        out[0][21] = 0.7;
        out[0][100] = 0.3;
        out[3].set([1, 1, 1, 1], 20 * 4);
        out[3].set([1, 1, 1, 1.2], 21 * 4);

        expect(decodeDetections(out, layout).map((face) => face.score.toFixed(1))).toEqual(["0.9"]);
    });
});

describe("choosing faces", () => {
    const at = (eyes: number, score = 0.9) => ({
        score,
        landmarks: [
            [0, 0],
            [eyes, 0],
            [0, 0],
            [0, 0],
            [0, 0],
        ] as Point[],
    });

    it("measures a face by the distance between its eyes", () => {
        expect(
            eyeDistance({
                landmarks: [
                    [0, 0],
                    [3, 4],
                    [0, 0],
                    [0, 0],
                    [0, 0],
                ],
            })
        ).toBe(5);
    });

    it("drops faces too small to recognise, then keeps the largest and surest", () => {
        const chosen = chooseFaces([at(8), at(20, 0.6), at(30), at(12)], 2);

        // Weighed by size times confidence: 20 px at 0.6 outranks 12 px at 0.9.
        expect(chosen.map(eyeDistance)).toEqual([30, 20]);
    });
});

describe("aligning a face", () => {
    it("leaves a face already in ArcFace's position where it is", () => {
        const [a, b, tx, ty] = alignment(ARCFACE);

        expect(a).toBeCloseTo(1, 6);
        expect(b).toBeCloseTo(0, 6);
        expect(tx).toBeCloseTo(0, 4);
        expect(ty).toBeCloseTo(0, 4);
    });

    it("undoes a face that is half the size and further along", () => {
        const [a, b, tx, ty] = alignment(
            ARCFACE.map(([x, y]) => [x / 2 + 30, y / 2 + 10] as Point)
        );

        expect(a).toBeCloseTo(2, 6);
        expect(b).toBeCloseTo(0, 6);
        expect(tx).toBeCloseTo(-60, 4);
        expect(ty).toBeCloseTo(-20, 4);
    });

    it("writes the aligned face normalised as ArcFace expects", () => {
        const rgb = new Uint8Array(200 * 200 * 3).fill(0);
        const out = new Float32Array(3 * FACE_SIDE * FACE_SIDE);

        writeFaceInput(rgb, 200, { x: 0, y: 0, width: 200, height: 200 }, ARCFACE, out);

        expect(out.every((value) => value === -1)).toBe(true);
    });
});

/** A unit vector mostly along one axis, leaning a little towards another. */
const person = (axis: number, lean = 0, towards = axis + 1): Float32Array => {
    const vector = new Float32Array(8);

    vector[axis] = 1;
    vector[towards] = lean;

    return normaliseVector(vector);
};

describe("people within an item", () => {
    it("gathers the faces of one person and keeps another apart", () => {
        const people = peopleInItem([person(0), person(0, 0.2), person(3), person(0, 0.1, 2)]);

        expect(people.map((p) => p.members)).toEqual([[0, 1, 3], [2]]);
    });
});

describe("people across the library", () => {
    let next = 0;
    const newId = (): string => `g${++next}`;
    const groups = (): Map<string, FaceGroup> => new Map();
    const one = (vector: Float32Array) => ({ members: [0], sum: Float32Array.from(vector) });

    it("starts a group for somebody new, and adds them to it when they return", () => {
        const library = groups();
        const first = placePerson(one(person(0)), library, newId);
        const again = placePerson(one(person(0, 0.3)), library, newId);
        const other = placePerson(one(person(4)), library, newId);

        expect(again.groupId).toBe(first.groupId);
        expect(other.groupId).not.toBe(first.groupId);
        expect(library.get(first.groupId)?.count).toBe(2);
    });

    it("joins two groups of one person when somebody close to both arrives", () => {
        const library = groups();
        // Two groups of one person, started too far apart to join (0.31): one leans each way.
        const left = placePerson(one(person(0, 1.5, 1)), library, newId);
        const right = placePerson(one(person(0, 1.5, 2)), library, newId);

        expect(left.groupId).not.toBe(right.groupId);

        // Between the two: 0.79 from each.
        const between = normaliseVector(Float32Array.from([1, 0.5, 0.5, 0, 0, 0, 0, 0]));
        const bridge = placePerson(one(between), library, newId);

        expect(library.size).toBe(1);
        expect(bridge.merged).toHaveLength(1);
        expect([left.groupId, right.groupId]).toContain(bridge.groupId);
        expect(library.get(bridge.groupId)?.count).toBe(3);
    });
});

describe("one face, one score", () => {
    const unit = (...values: number[]): Float32Array => normaliseVector(Float32Array.from(values));

    it("weighs each item once, however many of its faces there are", () => {
        // Twelve faces on one item pointing one way, one face on another pointing the other way.
        const centre = performerCentre([
            Array.from({ length: 12 }, () => unit(1, 0)),
            [unit(0, 1)],
        ]);

        expect(centre?.[0]).toBeCloseTo(centre![1]);
        expect(performerCentre([[], []])).toBeNull();
    });

    it("finds the face a performer's tagged items share, whoever else is in them", () => {
        const them = (i: number) => ({ mediaId: `m${i}`, vector: unit(1, 0.05 * i, 0) });
        // Each item has them, and a different second person: two of those strangers alike.
        const faces = [
            ...[0, 1, 2, 3, 4].map(them),
            { mediaId: "m0", vector: unit(0, 1, 0) },
            { mediaId: "m1", vector: unit(0, 0.95, 0.3) },
            { mediaId: "m2", vector: unit(0, 0, 1) },
        ];

        const shared = sharedFace(faces);

        expect(shared?.members.sort()).toEqual([0, 1, 2, 3, 4]);
        expect(shared).toMatchObject({ items: 5, share: 1 });
    });

    it("declines when two people are always together, or too few items say so", () => {
        const pair = [0, 1, 2, 3].flatMap((i) => [
            { mediaId: `m${i}`, vector: unit(1, 0) },
            { mediaId: `m${i}`, vector: unit(0, 1) },
        ]);

        expect(sharedFace(pair)).toBeNull();
        expect(
            sharedFace([
                { mediaId: "a", vector: unit(1, 0) },
                { mediaId: "b", vector: unit(1, 0) },
            ])
        ).toBeNull();
    });

    it("keeps references between runs, and finds a face's best match among them", () => {
        const anchors = [
            { tagId: "jane", items: 4, confirmedItems: 2, sharedItems: 3, centre: unit(1, 0) },
            { tagId: "kim", items: 3, confirmedItems: 0, sharedItems: 3, centre: unit(0, 1) },
        ];
        const back = decodeFaceAnchors(encodeFaceAnchors(2, anchors));

        expect(back.map((a) => [a.tagId, a.items, a.confirmedItems, a.sharedItems])).toEqual([
            ["jane", 4, 2, 3],
            ["kim", 3, 0, 3],
        ]);
        expect(back[1].centre[1]).toBeCloseTo(1);

        const match = bestMatch(unit(0.9, 0.1), back);

        expect(match?.tagId).toBe("jane");
        expect(match!.score - match!.second).toBeGreaterThan(0.5);
        expect(bestMatch(unit(1, 0), [])).toBeNull();
    });
});

describe("tagging by itself", () => {
    const evidence = { kind: "video" as const, moments: 3, score: 0.65, anchorItems: 6 };

    it("tags a person in a video seen often enough and clearly them, never a photograph", () => {
        expect(autoTags(evidence)).toBe(true);
        expect(autoTags({ ...evidence, moments: 2 })).toBe(false);
        expect(autoTags({ ...evidence, score: 0.59 })).toBe(false);
        expect(autoTags({ ...evidence, kind: "image" })).toBe(false);
    });

    it("needs a reference resting on enough items", () => {
        expect(autoTags({ ...evidence, anchorItems: 4 })).toBe(false);
    });

    it("tags by itself only once enough of its own proposals were checked right, none wrong", () => {
        expect(autoTagTrusted({ right: 29, wrong: 0 })).toBe(false);
        expect(autoTagTrusted({ right: 30, wrong: 0 })).toBe(true);
        expect(autoTagTrusted({ right: 60, wrong: 1 })).toBe(false);
    });

    it("brakes once enough was tagged and more than one in a hundred was taken back", () => {
        expect(autoTagBraked({ applied: 99, removed: 1 })).toBe(false);
        expect(autoTagBraked({ applied: 98, removed: 2 })).toBe(true);
        expect(autoTagBraked({ applied: 10, removed: 5 })).toBe(false);
    });
});

describe("the groups between runs", () => {
    it("round-trips ids, counts, sums and the cursor", () => {
        const groups = new Map<string, FaceGroup>([
            ["a", { id: "a", count: 3, sum: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]) }],
            ["b", { id: "b", count: 1, sum: Float32Array.from([-1, 0, 0.5, 0, 0, 0, 0, 2]) }],
        ]);
        const back = decodeFaceGroups(encodeFaceGroups({ cursor: 42, dims: 8, groups }));

        expect(back.cursor).toBe(42);
        expect([...back.groups.values()]).toEqual([...groups.values()]);
    });

    it("refuses bytes that are not a groups file", () => {
        expect(() => decodeFaceGroups(new Uint8Array(16))).toThrow();
    });
});

describe("whether a group is somebody's", () => {
    const none = {
        taggedAsThem: 0,
        taggedAsOthers: 0,
        confirmed: 0,
        confirmedOthers: 0,
        refused: 0,
    };

    it("proposes the performer most of its single-performer items carry, from two", () => {
        expect(groupStateFor({ ...none, taggedAsThem: 3, taggedAsOthers: 1 })).toBe("proposed");
        expect(groupStateFor({ ...none, taggedAsThem: 1 })).toBeNull();
        expect(groupStateFor({ ...none, taggedAsThem: 2, taggedAsOthers: 2 })).toBeNull();
    });

    it("is theirs once somebody says so, and not once somebody says it is not", () => {
        expect(groupStateFor({ ...none, confirmed: 1 })).toBe("confirmed");
        expect(groupStateFor({ ...none, taggedAsThem: 5, refused: 2 })).toBeNull();
        expect(groupStateFor({ ...none, confirmed: 1, refused: 3 })).toBeNull();
    });

    it("proposes nobody for a group somebody named as someone else", () => {
        expect(groupStateFor({ ...none, taggedAsThem: 5, confirmedOthers: 1 })).toBeNull();
    });
});

describe("appearances", () => {
    const unit = (x: number, y: number) => normaliseVector(Float32Array.from([x, y, 0]));
    const face = (vector: Float32Array, eyes = 30, score = 0.9) => ({ vector, eyes, score });

    it("gathers a video's faces into its people, each with their clearest face", () => {
        const people = appearancesInItem(
            [
                face(unit(1, 0), 20),
                face(unit(1, 0.1), 40),
                face(unit(0, 1)),
                face(unit(0.05, 1)),
                face(unit(-1, 0)),
            ],
            "video"
        );

        expect(people.map((person) => person.members)).toEqual([
            [0, 1],
            [2, 3],
        ]);
        expect(people[0].best).toBe(1);
    });

    it("keeps a photograph's single face, and says when the clearest is too small to read", () => {
        const [person] = appearancesInItem([face(unit(1, 0), LEGIBLE_EYES - 1)], "image");

        expect(person.members).toEqual([0]);
        expect(person.legible).toBe(false);
    });
});
