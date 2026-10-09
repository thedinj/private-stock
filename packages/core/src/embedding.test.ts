import { describe, expect, it } from "vitest";

import {
    EMBED_SIDE,
    decodeRepresentatives,
    decodeVectorFile,
    dequantize,
    encodeRepresentatives,
    encodeVectorFile,
    farthestPoints,
    lookPhrasings,
    meanDirection,
    normaliseVector,
    quantize,
    quantizedSimilarity,
    squaresIn,
    thinMoments,
    vectorSimilarity,
    writeModelInput,
    type Moment,
    type VectorFile,
} from "./embedding.js";

const unit = (...values: number[]): Float32Array => normaliseVector(Float32Array.from(values));

describe("squares a frame is seen as", () => {
    it("sees a near-square frame as one centred square", () => {
        expect(squaresIn({ x: 0, y: 0, width: 200, height: 220 })).toEqual([
            { x: 0, y: 10, width: 200, height: 200 },
        ]);
    });

    it("sees a vertical phone frame as a top and a bottom square", () => {
        expect(squaresIn({ x: 400, y: 356, width: 200, height: 356 })).toEqual([
            { x: 400, y: 356, width: 200, height: 200 },
            { x: 400, y: 512, width: 200, height: 200 },
        ]);
    });

    it("sees widescreen as a left and a right square", () => {
        const squares = squaresIn({ x: 0, y: 0, width: 200, height: 112 });

        expect(squares.map((square) => square.x)).toEqual([0, 88]);
        expect(squares.every((square) => square.width === 112 && square.y === 0)).toBe(true);
    });

    it("covers a very wide frame with three, and no more", () => {
        expect(squaresIn({ x: 0, y: 0, width: 233, height: 100 })).toHaveLength(3);
        expect(squaresIn({ x: 0, y: 0, width: 1000, height: 100 })).toHaveLength(3);
    });

    it("sees nothing in an empty rectangle", () => {
        expect(squaresIn({ x: 0, y: 0, width: 0, height: 100 })).toEqual([]);
    });
});

describe("model input", () => {
    it("normalises a flat colour the way CLIP does, in planar order", () => {
        const width = 50;
        const rgb = new Uint8Array(width * width * 3);

        for (let i = 0; i < width * width; i += 1) rgb.set([255, 0, 128], i * 3);

        const out = new Float32Array(3 * EMBED_SIDE * EMBED_SIDE);

        writeModelInput(rgb, width, width, { x: 0, y: 0, width, height: width }, out, 0);

        const plane = EMBED_SIDE * EMBED_SIDE;

        expect(out[0]).toBeCloseTo((1 - 0.48145466) / 0.26862954, 4);
        expect(out[plane]).toBeCloseTo((0 - 0.4578275) / 0.26130258, 4);
        expect(out[2 * plane + plane - 1]).toBeCloseTo((128 / 255 - 0.40821073) / 0.27577711, 4);
    });

    it("averages when shrinking, so a fine pattern becomes its mean rather than aliasing", () => {
        const width = 448;
        const rgb = new Uint8Array(width * width * 3);

        // Alternate black and white columns: any point sample lands on one or the other.
        for (let y = 0; y < width; y += 1) {
            for (let x = 0; x < width; x += 1) {
                rgb.fill(x % 2 === 0 ? 0 : 255, (y * width + x) * 3, (y * width + x) * 3 + 3);
            }
        }

        const out = new Float32Array(3 * EMBED_SIDE * EMBED_SIDE);

        writeModelInput(rgb, width, width, { x: 0, y: 0, width, height: width }, out, 0);

        expect(out[1000] * 0.26862954 + 0.48145466).toBeCloseTo(0.5, 2);
    });
});

describe("thinning moments", () => {
    const moment = (atMs: number, ...vectors: Float32Array[]): Moment => ({ atMs, vectors });

    it("keeps the first moment and every one that differs from the last kept", () => {
        const a = unit(1, 0);
        const b = unit(0, 1);

        expect(
            thinMoments([moment(0, a), moment(1, a), moment(2, b), moment(3, b), moment(4, a)])
        ).toEqual([0, 2, 4]);
    });

    it("compares with the last kept moment, so a slow drift is still recorded", () => {
        const drift = [0, 0.2, 0.4, 0.6].map((angle) => unit(Math.cos(angle), Math.sin(angle)));

        // Each step is ~0.98 similar to the one before, but the third is 0.92 from the first.
        expect(thinMoments(drift.map((vector, index) => moment(index, vector)))).toEqual([0, 2]);
    });

    it("keeps a moment when any one of its squares changed", () => {
        const still = unit(1, 0);

        expect(thinMoments([moment(0, still, unit(1, 0)), moment(1, still, unit(0, 1))])).toEqual([
            0, 1,
        ]);
    });
});

describe("representatives", () => {
    it("picks the most different vectors first", () => {
        const vectors = [unit(1, 0, 0), unit(0.99, 0.1, 0), unit(0, 1, 0), unit(0, 0, 1)];

        expect(farthestPoints(vectors, 3).sort()).toEqual([0, 2, 3]);
    });

    it("returns everything when there are fewer than asked for", () => {
        expect(farthestPoints([unit(1, 0), unit(0, 1)], 8)).toEqual([0, 1]);
        expect(farthestPoints([], 8)).toEqual([]);
    });
});

describe("storage", () => {
    it("quantizes to within half a step of each value", () => {
        const vector = unit(0.3, -0.8, 0.1, 0.5);
        const restored = dequantize(quantize(vector));

        restored.forEach((value, index) => {
            expect(Math.abs(value - vector[index])).toBeLessThan(0.8 / 127);
        });
        expect(vectorSimilarity(normaliseVector(restored), vector)).toBeGreaterThan(0.999);
    });

    it("scores a stored vector in place, as its dequantized copy would be scored", () => {
        const query = unit(0.2, 0.9, -0.1, 0.3);
        const a = quantize(unit(1, 2, 3, 4));
        const b = quantize(unit(-1, 0, 2, 0));
        // Two stored end to end, as the web process keeps its index.
        const run = new Int8Array(8);

        run.set(a.values, 0);
        run.set(b.values, 4);

        expect(quantizedSimilarity(query, run, b.scale, 4)).toBeCloseTo(
            vectorSimilarity(query, dequantize(b)),
            6
        );
        expect(quantizedSimilarity(query, a.values, a.scale)).toBeCloseTo(
            vectorSimilarity(query, dequantize(a)),
            6
        );
    });

    const file: VectorFile = {
        model: "clip-b32-vision-uint8",
        stageVersion: 1,
        dims: 4,
        vectors: [
            { atMs: 0, square: 0, vector: quantize(unit(1, 2, 3, 4)) },
            { atMs: 0, square: 1, vector: quantize(unit(-1, 0, 2, 0)) },
            { atMs: 5000, square: 0, vector: quantize(unit(0, 0, 0, 1)) },
        ],
        representatives: [0, 2],
    };

    it("round-trips a vectors file", () => {
        const decoded = decodeVectorFile(encodeVectorFile(file));

        expect(decoded.model).toBe(file.model);
        expect(decoded.representatives).toEqual([0, 2]);
        expect(decoded.vectors.map((entry) => [entry.atMs, entry.square])).toEqual([
            [0, 0],
            [0, 1],
            [5000, 0],
        ]);
        expect(Array.from(decoded.vectors[1].vector.values)).toEqual(
            Array.from(file.vectors[1].vector.values)
        );
        expect(decoded.vectors[2].vector.scale).toBeCloseTo(file.vectors[2].vector.scale, 6);
    });

    it("records a photograph's moment as having no time", () => {
        const still = {
            ...file,
            vectors: [{ ...file.vectors[0], atMs: null }],
            representatives: [0],
        };

        expect(decodeVectorFile(encodeVectorFile(still)).vectors[0].atMs).toBeNull();
    });

    it("refuses bytes that are not a vectors file", () => {
        expect(() => decodeVectorFile(new Uint8Array(16))).toThrow();
    });

    it("reads a representatives log, keeping only complete records", () => {
        const first = encodeRepresentatives("item-a", file);
        const second = encodeRepresentatives("item-b", { ...file, representatives: [1] });
        const log = new Uint8Array(first.length + second.length);

        log.set(first, 0);
        log.set(second, first.length);

        const { records, length } = decodeRepresentatives(log);

        expect(records.map((record) => [record.mediaId, record.vectors.length])).toEqual([
            ["item-a", 2],
            ["item-b", 1],
        ]);
        expect(records[0].vectors[1].atMs).toBe(5000);
        expect(records[1].vectors[0].square).toBe(1);

        expect(length).toBe(log.length);

        // A record cut short -- a crash mid-append, or a read while one is being written -- is
        // left out, and the length says where to start reading again to get it whole.
        const partial = decodeRepresentatives(log.subarray(0, log.length - 3));

        expect(partial.records).toHaveLength(1);
        expect(partial.length).toBe(first.length);
    });
});

describe("asking for a look", () => {
    it("points between the vectors it combines, at unit length", () => {
        const mean = meanDirection([unit(1, 0), unit(0, 1)]);

        expect(mean[0]).toBeCloseTo(Math.SQRT1_2, 6);
        expect(mean[1]).toBeCloseTo(Math.SQRT1_2, 6);
    });

    it("phrases words as they are and as a caption", () => {
        expect(lookPhrasings("Neon at Night")).toEqual([
            "Neon at Night",
            "a photo of neon at night",
        ]);
    });
});
