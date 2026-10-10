/**
 * The arithmetic of reading faces (§5f): where the detector looks, what it found, how a face is
 * squared up for the recogniser, and which faces are worth keeping.
 *
 * Pure and dependency-free, as `embedding.ts` is, so it can be tested without a model; the models
 * run in the worker's model child. The two are InsightFace's large set, chosen by the bake-off:
 * SCRFD-10G finds faces and five landmarks each, and ArcFace R50 turns a face aligned on those
 * landmarks into 512 numbers.
 */

import type { MediaKind } from "./domain.js";
import { normaliseVector, vectorSimilarity, type Rect } from "./embedding.js";
import { ValidationError } from "./errors.js";

/** The detector sees a region scaled so its long side is this, in multiples of 32 (§5f). */
export const DETECTOR_LONG_SIDE = 640;

/** The side of the aligned face the recogniser reads. */
export const FACE_SIDE = 112;

/** A detection is kept from this confidence. SCRFD's own default. */
export const FACE_SCORE = 0.5;

/** Overlapping detections of one face are merged above this intersection-over-union. */
const NMS_OVERLAP = 0.4;

/**
 * The smallest face worth recognising: pixels between the eyes, in the picture it was found in.
 * The bake-off kept 10 — raising it lost videos without naming fewer strangers (§5f).
 */
export const FACE_MIN_EYES = 10;

/** Every second sprite tile is read: measured, it cost almost nothing (§5f). */
export const FACE_TILE_STRIDE = 2;

/** At most this many faces an item go to the recogniser: the largest, best detected first. */
export const FACE_CAP = 12;

/** Where ArcFace expects the five landmarks of a 112-pixel face: eyes, nose, mouth corners. */
const ARCFACE_LANDMARKS: readonly (readonly [number, number])[] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

export type Point = readonly [number, number];

export interface Detection {
    score: number;
    /** In the region's own pixels. */
    box: Rect;
    /** Left eye, right eye, nose, left and right mouth corners, in the region's pixels. */
    landmarks: Point[];
}

/** How a region is laid into the detector's input: its scale and the padded size. */
export interface DetectorLayout {
    scale: number;
    width: number;
    height: number;
}

/**
 * The detector's input for a region: its long side scaled to `DETECTOR_LONG_SIDE`, each side
 * padded up to a multiple of 32, which SCRFD's three strides need. Not padded to a square — a
 * wide tile would be two-fifths padding, and the detector's cost is in its area.
 */
export const detectorLayout = (width: number, height: number): DetectorLayout => {
    const scale = DETECTOR_LONG_SIDE / Math.max(width, height);
    const pad = (side: number): number => Math.max(32, Math.ceil((side * scale) / 32) * 32);

    return { scale, width: pad(width), height: pad(height) };
};

/** An RGB pixel with bilinear interpolation, clamped to the region. */
const sample = (
    rgb: Uint8Array,
    imageWidth: number,
    region: Rect,
    x: number,
    y: number,
    channel: number
): number => {
    const fx = Math.min(Math.max(x, 0), region.width - 1);
    const fy = Math.min(Math.max(y, 0), region.height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, region.width - 1);
    const y1 = Math.min(y0 + 1, region.height - 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const at = (px: number, py: number): number =>
        rgb[((Math.floor(region.y) + py) * imageWidth + Math.floor(region.x) + px) * 3 + channel];

    return (
        (at(x0, y0) * (1 - ax) + at(x1, y0) * ax) * (1 - ay) +
        (at(x0, y1) * (1 - ax) + at(x1, y1) * ax) * ay
    );
};

/**
 * Write a region of an RGB image into the detector's input, as SCRFD expects it: RGB,
 * (value − 127.5) / 128, channel-planar, top-left aligned, zero beyond the region.
 */
export const writeDetectorInput = (
    rgb: Uint8Array,
    imageWidth: number,
    region: Rect,
    layout: DetectorLayout,
    out: Float32Array
): void => {
    const plane = layout.width * layout.height;
    const width = Math.min(layout.width, Math.round(region.width * layout.scale));
    const height = Math.min(layout.height, Math.round(region.height * layout.scale));

    out.fill(0);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const sx = (x + 0.5) / layout.scale - 0.5;
            const sy = (y + 0.5) / layout.scale - 0.5;
            const i = y * layout.width + x;

            for (let channel = 0; channel < 3; channel += 1) {
                out[channel * plane + i] =
                    (sample(rgb, imageWidth, region, sx, sy, channel) - 127.5) / 128;
            }
        }
    }
};

const overlap = (a: Rect, b: Rect): number => {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

    return inter / (a.width * a.height + b.width * b.height - inter);
};

/**
 * What SCRFD found, in the region's pixels.
 *
 * `outputs` in the model's order: scores, then boxes, then landmarks, each at strides 8, 16 and
 * 32. Two anchors per position; a box is the anchor's distances to its four sides, and a
 * landmark the anchor's offset to it, both in strides.
 */
export const decodeDetections = (
    outputs: readonly Float32Array[],
    layout: DetectorLayout,
    threshold = FACE_SCORE
): Detection[] => {
    const found: Detection[] = [];

    [8, 16, 32].forEach((stride, level) => {
        const scores = outputs[level];
        const boxes = outputs[level + 3];
        const points = outputs[level + 6];
        const columns = layout.width / stride;

        for (let i = 0; i < scores.length; i += 1) {
            if (scores[i] < threshold) continue;

            const cell = Math.floor(i / 2);
            const cx = (cell % columns) * stride;
            const cy = Math.floor(cell / columns) * stride;
            const x1 = cx - boxes[i * 4] * stride;
            const y1 = cy - boxes[i * 4 + 1] * stride;
            const x2 = cx + boxes[i * 4 + 2] * stride;
            const y2 = cy + boxes[i * 4 + 3] * stride;
            const landmarks: Point[] = [];

            for (let n = 0; n < 5; n += 1) {
                landmarks.push([
                    (cx + points[i * 10 + 2 * n] * stride) / layout.scale,
                    (cy + points[i * 10 + 2 * n + 1] * stride) / layout.scale,
                ]);
            }

            found.push({
                score: scores[i],
                box: {
                    x: x1 / layout.scale,
                    y: y1 / layout.scale,
                    width: (x2 - x1) / layout.scale,
                    height: (y2 - y1) / layout.scale,
                },
                landmarks,
            });
        }
    });

    // Best first; each kept detection suppresses the ones that are the same face.
    found.sort((a, b) => b.score - a.score);

    const kept: Detection[] = [];

    for (const detection of found) {
        if (kept.every((other) => overlap(other.box, detection.box) < NMS_OVERLAP)) {
            kept.push(detection);
        }
    }

    return kept;
};

/** Pixels between the eyes: how large a face is, whatever its box says. */
export const eyeDistance = (detection: Pick<Detection, "landmarks">): number => {
    const [left, right] = detection.landmarks;

    return Math.hypot(right[0] - left[0], right[1] - left[1]);
};

/**
 * The faces of an item worth recognising: large enough, then the largest and best detected,
 * up to `cap`. The order a person would trust them in, which is also the order kept.
 */
export const chooseFaces = <T extends Pick<Detection, "score" | "landmarks">>(
    detections: readonly T[],
    cap = FACE_CAP
): T[] =>
    detections
        .filter((detection) => eyeDistance(detection) >= FACE_MIN_EYES)
        .map((detection) => ({ detection, weight: detection.score * eyeDistance(detection) }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, cap)
        .map(({ detection }) => detection);

/**
 * The similarity transform taking a face's landmarks onto ArcFace's: `[a, b, tx, ty]` for
 * u = a·x − b·y + tx, v = b·x + a·y + ty. Least squares over the five points (Umeyama), so one
 * badly placed landmark tilts the face less than it would with two.
 */
export const alignment = (landmarks: readonly Point[]): [number, number, number, number] => {
    const n = landmarks.length;
    let msx = 0;
    let msy = 0;
    let mdx = 0;
    let mdy = 0;

    landmarks.forEach(([x, y], i) => {
        msx += x / n;
        msy += y / n;
        mdx += ARCFACE_LANDMARKS[i][0] / n;
        mdy += ARCFACE_LANDMARKS[i][1] / n;
    });

    let dotSum = 0;
    let crossSum = 0;
    let spread = 0;

    landmarks.forEach(([x, y], i) => {
        const sx = x - msx;
        const sy = y - msy;
        const dx = ARCFACE_LANDMARKS[i][0] - mdx;
        const dy = ARCFACE_LANDMARKS[i][1] - mdy;

        dotSum += sx * dx + sy * dy;
        crossSum += sx * dy - sy * dx;
        spread += sx * sx + sy * sy;
    });

    const a = dotSum / spread;
    const b = crossSum / spread;

    return [a, b, mdx - (a * msx - b * msy), mdy - (b * msx + a * msy)];
};

/**
 * Write a face into the recogniser's input, squared up on its landmarks: each of the 112 × 112
 * output pixels mapped back through the inverse transform and sampled from the region. RGB,
 * (value − 127.5) / 127.5, channel-planar, as ArcFace was trained.
 */
export const writeFaceInput = (
    rgb: Uint8Array,
    imageWidth: number,
    region: Rect,
    landmarks: readonly Point[],
    out: Float32Array
): void => {
    const [a, b, tx, ty] = alignment(landmarks);
    const det = a * a + b * b;
    const plane = FACE_SIDE * FACE_SIDE;

    for (let v = 0; v < FACE_SIDE; v += 1) {
        for (let u = 0; u < FACE_SIDE; u += 1) {
            const du = u - tx;
            const dv = v - ty;
            const x = (a * du + b * dv) / det;
            const y = (-b * du + a * dv) / det;

            for (let channel = 0; channel < 3; channel += 1) {
                out[channel * plane + v * FACE_SIDE + u] =
                    (sample(rgb, imageWidth, region, x, y, channel) - 127.5) / 127.5;
            }
        }
    }
};

/**
 * How alike two faces must be to be one person within an item: the bake-off's grouping line
 * (§5f). Low, because the faces of one video share its light and grain, and a second person in
 * it is usually far further away than that.
 */
export const SAME_PERSON_IN_ITEM = 0.35;

/** One person within an item: which of its faces, and their direction together. */
export interface ItemPerson {
    members: number[];
    sum: Float32Array;
}

/**
 * An item's faces gathered into people: each joins the person whose faces it is nearest on
 * average, if near enough, in the order given — which is the order the stage kept them in, most
 * trusted first.
 */
export const peopleInItem = (
    vectors: readonly Float32Array[],
    near = SAME_PERSON_IN_ITEM
): ItemPerson[] => {
    const people: ItemPerson[] = [];

    vectors.forEach((vector, index) => {
        let best: ItemPerson | null = null;
        let bestSimilarity = near;

        for (const person of people) {
            const similarity = vectorSimilarity(normaliseVector(person.sum), vector);

            if (similarity >= bestSimilarity) {
                best = person;
                bestSimilarity = similarity;
            }
        }

        if (best) {
            best.members.push(index);
            best.sum = best.sum.map((value, i) => value + vector[i]);
        } else {
            people.push({ members: [index], sum: Float32Array.from(vector) });
        }
    });

    return people;
};

/**
 * How alike two single faces must be to be counted as one person when finding the face a
 * performer's tagged items share (`sharedFace`). Looser than a group's line, since one face is
 * noisier than a group's sum; tighter than one item's, since two videos share no light.
 */
export const SAME_FACE_ACROSS_ITEMS = 0.45;

/**
 * A performer's face is the one their tagged items share when it is on at least this share of
 * them — and no second face comes close (`SHARED_RUNNER_UP`). Measured 2026-10-08: of the 33
 * performers with five or more confirmed items, the face found this way, from tags alone, was the
 * confirmed one for all 33, and none of the 1,293 decided faces in it had been decided otherwise.
 */
export const SHARED_MIN_SHARE = 0.6;

/** …and the next most shared face is on at most this fraction of what the first is on. */
export const SHARED_RUNNER_UP = 0.5;

/** A reference needs this many items behind it, so no one video decides who somebody is. */
export const ANCHOR_MIN_ITEMS = 3;

/**
 * How alike a face must be to a performer's reference to be counted as looking like them, and by
 * how much more than like anybody else: a group nobody's tags or decisions point to is asked
 * about as them ("Looks like them") when enough of its items do (§5f "One face, one score").
 */
export const LOOKS_LIKE = 0.45;
export const LOOKS_LIKE_MARGIN = 0.1;

const sumUnit = (vectors: readonly Float32Array[]): Float32Array => {
    const sum = new Float32Array(vectors[0].length);

    for (const vector of vectors) for (let i = 0; i < sum.length; i += 1) sum[i] += vector[i];

    return normaliseVector(sum);
};

/**
 * A performer's reference: the mean of their faces item by item, then across items, so an item
 * with twelve faces of them has the same say as one with a single face (§5f "One face, one
 * score"). Null with no faces.
 */
export const performerCentre = (
    byItem: readonly (readonly Float32Array[])[]
): Float32Array | null => {
    const items = byItem.filter((faces) => faces.length > 0).map((faces) => sumUnit(faces));

    return items.length > 0 ? sumUnit(items) : null;
};

/** A face that may be the one a performer's tagged items share. */
export interface TaggedFace {
    mediaId: string;
    vector: Float32Array;
}

/** The face a performer's tagged items share, if one clearly is. */
export interface SharedFace {
    /** Indices into the faces given: the faces of that person. */
    members: number[];
    /** Items it is on, and the share of the items given. */
    items: number;
    share: number;
    /** The share the next most shared face is on, for the record. */
    runnerUp: number;
}

/**
 * The face a performer's tagged items share (§5f "One face, one score"): the face that recurs
 * across nearly all of them, where everybody else on screen varies — scenes with two or three
 * people included, which the group proposals ignore. Null when no face is on `SHARED_MIN_SHARE`
 * of the items or a second comes too close (two people always together), or too few items.
 *
 * Every face against every other: the cost is the square of a performer's faces, so the caller
 * caps how many items it hands over.
 */
export const sharedFace = (
    faces: readonly TaggedFace[],
    same = SAME_FACE_ACROSS_ITEMS
): SharedFace | null => {
    const itemCount = new Set(faces.map((face) => face.mediaId)).size;

    if (itemCount < ANCHOR_MIN_ITEMS) {
        return null;
    }

    const cluster = (pool: readonly number[]): { members: number[]; items: number } | null => {
        let seed = -1;
        let seedSupport = -1;

        for (const i of pool) {
            const seen = new Set<string>();

            for (const j of pool) {
                if (faces[j].mediaId !== faces[i].mediaId && !seen.has(faces[j].mediaId)) {
                    if (vectorSimilarity(faces[i].vector, faces[j].vector) >= same) {
                        seen.add(faces[j].mediaId);
                    }
                }
            }

            if (seen.size > seedSupport) {
                seed = i;
                seedSupport = seen.size;
            }
        }

        if (seed < 0) return null;

        // Around the seed, then around the centre of what joined it, so one odd seed does not
        // decide the edge.
        const near = pool.filter(
            (j) => vectorSimilarity(faces[seed].vector, faces[j].vector) >= same
        );
        const centre = sumUnit(near.map((j) => faces[j].vector));
        const members = pool.filter((j) => vectorSimilarity(centre, faces[j].vector) >= same);

        return { members, items: new Set(members.map((j) => faces[j].mediaId)).size };
    };

    const all = faces.map((_, i) => i);
    const first = cluster(all);

    if (!first) return null;

    const taken = new Set(first.members);
    const second = cluster(all.filter((i) => !taken.has(i)));
    const share = first.items / itemCount;
    const runnerUp = second ? second.items / itemCount : 0;

    return share >= SHARED_MIN_SHARE && runnerUp <= share * SHARED_RUNNER_UP
        ? { members: first.members, items: first.items, share, runnerUp }
        : null;
};

/**
 * Tagging by itself (§5f "Tagging by itself"): when an item is the performer without asking.
 *
 * Per person in an item (an appearance), not per face: a video person seen at least
 * `AUTO_TAG_MIN_MOMENTS` times whose faces together match them at `AUTO_TAG_LINE`, `AUTO_TAG_MARGIN`
 * more than anybody else, their reference resting on `AUTO_TAG_MIN_ITEMS` items; nothing on the
 * item refused for them, and no face of the person refused by somebody who saw it. Photographs
 * never: there is no measure of them yet. A name never tags.
 *
 * Measured 2026-10-10, leave-one-item-out: no person people refused scored above 0.552 (failing
 * the margin), and this rule takes in 73% of the people they confirmed — the rule it replaces, two
 * strong faces each on their own, 29%.
 */
export const AUTO_TAG_LINE = 0.6;
export const AUTO_TAG_MARGIN = 0.1;
export const AUTO_TAG_MIN_MOMENTS = 3;
export const AUTO_TAG_MIN_ITEMS = 5;

/** Which rule proposes now: `FaceAutoTag.rule`, so its own tally is told from the last one's. */
export const AUTO_TAG_RULE = 2;

/**
 * A rule tags by itself only once this many of its own proposals were checked in "Would tag",
 * and none of them was wrong. Until then it proposes, and waits.
 */
export const AUTO_TAG_TRIAL = 30;

/** What one person in an item says about one performer, for the rule. */
export interface AutoTagEvidence {
    kind: MediaKind;
    /** How many of the item's faces are this person. */
    moments: number;
    /** Their faces together against the performer's reference, with the margin. */
    score: number;
    /** Items the reference rests on. */
    anchorItems: number;
}

/** Whether the rule tags this item as this performer. */
export const autoTags = (evidence: AutoTagEvidence): boolean =>
    evidence.kind === "video" &&
    evidence.moments >= AUTO_TAG_MIN_MOMENTS &&
    evidence.score >= AUTO_TAG_LINE &&
    evidence.anchorItems >= AUTO_TAG_MIN_ITEMS;

/** Whether the rule's own checked proposals let it tag by itself (`AUTO_TAG_TRIAL`). */
export const autoTagTrusted = (trial: { right: number; wrong: number }): boolean =>
    trial.right >= AUTO_TAG_TRIAL && trial.wrong === 0;

/**
 * When faces stop tagging by themselves (§5f "Tagging by itself"): once enough has been tagged to
 * judge, more than this share of it taken back by people. The brake holds until the share falls,
 * or somebody looks at why.
 */
export const AUTO_TAG_BRAKE_SHARE = 0.01;
export const AUTO_TAG_BRAKE_AFTER = 50;

/** Whether what people took back says faces should stop tagging by themselves. */
export const autoTagBraked = (counts: { applied: number; removed: number }): boolean => {
    const made = counts.applied + counts.removed;

    return made >= AUTO_TAG_BRAKE_AFTER && counts.removed / made > AUTO_TAG_BRAKE_SHARE;
};

/** A performer's reference, as the anchors file keeps it. */
export interface FaceAnchor {
    tagId: string;
    /** Items behind it, and of those, how many by a person's confirmation and how many by tags. */
    items: number;
    confirmedItems: number;
    sharedItems: number;
    centre: Float32Array;
}

const ANCHORS_MAGIC = [0x50, 0x53, 0x46, 0x41]; // "PSFA"

/** Bytes on disk: magic, a JSON header of the anchors' counts, then each centre as float32. */
export const encodeFaceAnchors = (dims: number, anchors: readonly FaceAnchor[]): Uint8Array => {
    const header = new TextEncoder().encode(
        JSON.stringify({
            version: 1,
            dims,
            anchors: anchors.map((a) => [a.tagId, a.items, a.confirmedItems, a.sharedItems]),
        })
    );
    const bytes = new Uint8Array(8 + header.length + anchors.length * dims * 4);
    const view = new DataView(bytes.buffer);

    bytes.set(ANCHORS_MAGIC, 0);
    view.setUint32(4, header.length, true);
    bytes.set(header, 8);

    let at = 8 + header.length;

    for (const anchor of anchors) {
        for (let i = 0; i < dims; i += 1) {
            view.setFloat32(at, anchor.centre[i], true);
            at += 4;
        }
    }

    return bytes;
};

export const decodeFaceAnchors = (bytes: Uint8Array): FaceAnchor[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (ANCHORS_MAGIC.some((value, index) => bytes[index] !== value)) {
        throw new ValidationError("Not a face anchors file");
    }

    const length = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as {
        version: number;
        dims: number;
        anchors: [string, number, number, number][];
    };

    if (header.version !== 1) {
        throw new ValidationError("A face anchors file this version cannot read");
    }

    let at = 8 + length;

    return header.anchors.map(([tagId, items, confirmedItems, sharedItems]) => {
        const centre = new Float32Array(header.dims);

        for (let i = 0; i < header.dims; i += 1) {
            centre[i] = view.getFloat32(at, true);
            at += 4;
        }

        return { tagId, items, confirmedItems, sharedItems, centre };
    });
};

/**
 * A face's best match among the references, and the next best: what "looks like them" and, later,
 * tagging by itself read (§5f "One face, one score"). Null when there are no references.
 */
export const bestMatch = (
    vector: Float32Array,
    anchors: readonly FaceAnchor[]
): { tagId: string; score: number; second: number } | null => {
    let best: FaceAnchor | null = null;
    let score = -Infinity;
    let second = -Infinity;

    for (const anchor of anchors) {
        const s = vectorSimilarity(anchor.centre, vector);

        if (s > score) {
            second = score;
            score = s;
            best = anchor;
        } else if (s > second) {
            second = s;
        }
    }

    return best ? { tagId: best.tagId, score, second: second === -Infinity ? 0 : second } : null;
};

/**
 * Appearances (§5f "A person in a video"): one person in one item — what is shown and asked
 * about, rather than each face the stage happened to keep. Within one item a looser line than
 * across the library is safe: the faces share the item's light and grain, and look-alikes rarely
 * share a scene. 0.30 rather than the grouping's 0.35, which split one person in 57 of 576 videos
 * with a confirmed face (37 at 0.30); looser still began to take in faces refused as them.
 */
export const APPEARANCE_NEAR = 0.3;

/** A person in a video is seen at least twice: a single face there is too little to ask about. */
export const APPEARANCE_MIN_VIDEO_FACES = 2;

/**
 * Legible enough to show (§5f "A person in a video"): an appearance is shown only if its best
 * face is this large and this sure. A line for being read, not for being right — refused faces
 * pass it as often as confirmed ones — at 16 px it keeps 90% of what people confirmed on screen,
 * where 20 px and 0.7 hid a quarter of it.
 */
export const LEGIBLE_EYES = 16;
export const LEGIBLE_SCORE = 0.6;

/**
 * Suggested (§5f "Suggestions"): an appearance whose people's centre is this like a performer's
 * reference, and this much more than like anybody else. Scored per appearance, not per face: at
 * this line 83% of the appearances people confirmed pass and none of the 170 they refused, where
 * per face it kept fewer than half the confirmed faces.
 */
export const SUGGEST_LINE = 0.55;
export const SUGGEST_MARGIN = 0.1;

/** Suggested at a lower line where the item's own text names them too. */
export const SUGGEST_NAMED_LINE = 0.45;

/** A face of an item, for gathering it into the item's people. */
export interface AppearanceFace {
    vector: Float32Array;
    eyes: number;
    score: number;
}

/** One person in one item: which of its faces, the clearest of them, and their direction. */
export interface Appearance {
    members: number[];
    best: number;
    centre: Float32Array;
    legible: boolean;
}

/**
 * An item's people (§5f "A person in a video"): its faces gathered at `APPEARANCE_NEAR`, each
 * person with their clearest face — the largest and surest — and the direction of all of them.
 * In a video a person seen once is left out; a photograph's single face is its person.
 */
export const appearancesInItem = (
    faces: readonly AppearanceFace[],
    kind: "video" | "image"
): Appearance[] =>
    peopleInItem(
        faces.map((face) => face.vector),
        APPEARANCE_NEAR
    )
        .filter((person) => kind === "image" || person.members.length >= APPEARANCE_MIN_VIDEO_FACES)
        .map((person) => {
            const best = person.members.reduce((a, b) =>
                faces[b].eyes * faces[b].score > faces[a].eyes * faces[a].score ? b : a
            );

            return {
                members: person.members,
                best,
                centre: normaliseVector(person.sum),
                legible: faces[best].eyes >= LEGIBLE_EYES && faces[best].score >= LEGIBLE_SCORE,
            };
        });

/**
 * New people (§5f "New people"): people in items who match nobody known, gathered across the
 * library into the ones worth naming — what replaces Unnamed and its groups.
 *
 * Only people who match no reference (`NEW_PERSON_UNMATCHED`), nobody decided about, with a clear
 * face (`NEW_PERSON_EYES`, `NEW_PERSON_SCORE` — stricter than to be shown, as a stranger is named
 * from a few faces alone). Each joins the nearest gathering whose centre is `NEW_PERSON_NEAR` like
 * them, or starts one; nothing merges by a bridging face. A gathering on fewer than
 * `NEW_PERSON_MIN_ITEMS` items is a face seen in passing, and is not asked about. Measured
 * 2026-10-10: about 110 gatherings of three or more, covering some 460 videos, median four.
 */
export const NEW_PERSON_UNMATCHED = 0.4;
export const NEW_PERSON_EYES = 20;
export const NEW_PERSON_SCORE = 0.7;
export const NEW_PERSON_NEAR = 0.55;
export const NEW_PERSON_MIN_ITEMS = 3;

/**
 * Gather people into new people: each, in the order given, joins the gathering whose centre is
 * nearest if at least `near` alike, or starts one. Returns each person's gathering, by index, and
 * which gatherings rest on `minItems` items or more — the rest are null.
 */
export const gatherNewPeople = (
    people: readonly { centre: Float32Array; mediaId: string }[],
    near = NEW_PERSON_NEAR,
    minItems = NEW_PERSON_MIN_ITEMS
): (number | null)[] => {
    const sums: Float32Array[] = [];
    const items: Set<string>[] = [];
    const joined = people.map((person) => {
        let best = -1;
        let bestSimilarity = near;

        sums.forEach((sum, index) => {
            const similarity = vectorSimilarity(normaliseVector(sum), person.centre);

            if (similarity >= bestSimilarity) {
                best = index;
                bestSimilarity = similarity;
            }
        });

        if (best < 0) {
            sums.push(Float32Array.from(person.centre));
            items.push(new Set([person.mediaId]));

            return sums.length - 1;
        }

        sums[best] = sums[best].map((value, i) => value + person.centre[i]);
        items[best].add(person.mediaId);

        return best;
    });

    return joined.map((index) => (items[index].size >= minItems ? index : null));
};
