import { describe, expect, it } from "vitest";

import {
    PHASH_BANDS,
    PHASH_BAND_BITS,
    PHASH_BITS,
    PHASH_BYTES,
    PHASH_MAX_INDEXED_DISTANCE,
    PHASH_SIZE,
    hammingDistance,
    hashBands,
    hashFromHex,
    hashToHex,
    phashFromLuma,
} from "./phash.js";

/**
 * A perceptual hash is only worth having if it is stable under the changes a library
 * actually contains — rescaling, re-encoding, brightness drift — and unstable under
 * everything else. Both halves are tested here against synthetic images, which is far
 * stronger evidence than eyeballing a pair of thumbnails: the transformations are exact and
 * the comparison is a number.
 */

const size = PHASH_SIZE;

/** An image from a function of position, in the 0-255 range the decoder produces. */
const render = (fn: (x: number, y: number) => number): Uint8Array => {
    const pixels = new Uint8Array(size * size);

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            pixels[y * size + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
        }
    }

    return pixels;
};

/**
 * A synthetic image with energy across the whole low-frequency block.
 *
 * Built as a sum over every basis frequency the hash reads, with amplitudes falling off like
 * 1/f -- which is roughly how natural images are distributed, and the property that matters
 * here. An earlier fixture was a sum of three sine waves: pretty, but only about six DCT
 * coefficients were non-zero and the other fifty-seven were rounding dust. The median then
 * sat *in* that dust, so most hash bits were decided by floating-point noise and every
 * stability assertion measured nothing. The algorithm was fine; the fixture was not an image.
 */
const spectralImage = (seed: number): Uint8Array => {
    const amplitudes: number[] = [];

    for (let v = 0; v < 8; v += 1) {
        for (let u = 0; u < 8; u += 1) {
            // Deterministic per (seed, u, v), so failures reproduce exactly.
            const pseudo = Math.sin(seed * 97.13 + u * 12.9898 + v * 78.233) * 43758.5453;

            amplitudes.push((pseudo - Math.floor(pseudo) - 0.5) / (u + v + 1));
        }
    }

    const raw = new Float64Array(size * size);
    let peak = 0;

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            let value = 0;

            for (let v = 0; v < 8; v += 1) {
                for (let u = 0; u < 8; u += 1) {
                    if (u === 0 && v === 0) continue;

                    value +=
                        amplitudes[v * 8 + u] *
                        Math.cos((Math.PI * u * (x + 0.5)) / size) *
                        Math.cos((Math.PI * v * (y + 0.5)) / size);
                }
            }

            raw[y * size + x] = value;
            peak = Math.max(peak, Math.abs(value));
        }
    }

    // Scaled to use most of the range without touching either end, so a later brightness
    // shift is a shift rather than a clip.
    return render((x, y) => 128 + (raw[y * size + x] / peak) * 90);
};

const photograph = spectralImage(1);
const differentPhotograph = spectralImage(2);

/**
 * Downscale to half and back, by averaging then nearest-neighbour.
 *
 * Stands in for the single most common near-duplicate in a real library: the same picture at
 * a lower resolution, scaled back up for comparison. Detail is genuinely destroyed, so this
 * is not a no-op dressed up as a transformation.
 */
const halfResolution = (pixels: Uint8Array): Uint8Array => {
    const half = new Uint8Array((size / 2) * (size / 2));

    for (let y = 0; y < size / 2; y += 1) {
        for (let x = 0; x < size / 2; x += 1) {
            half[y * (size / 2) + x] = Math.round(
                (pixels[y * 2 * size + x * 2] +
                    pixels[y * 2 * size + x * 2 + 1] +
                    pixels[(y * 2 + 1) * size + x * 2] +
                    pixels[(y * 2 + 1) * size + x * 2 + 1]) /
                    4
            );
        }
    }

    return render((x, y) => half[Math.floor(y / 2) * (size / 2) + Math.floor(x / 2)]);
};

describe("phashFromLuma", () => {
    it("produces a 64-bit hash", () => {
        expect(phashFromLuma(photograph).hash).toHaveLength(PHASH_BYTES);
        expect(PHASH_BYTES * 8).toBe(PHASH_BITS);
    });

    it("is deterministic", () => {
        expect(hashToHex(phashFromLuma(photograph).hash)).toBe(
            hashToHex(phashFromLuma(photograph).hash)
        );
    });

    it("rejects an input of the wrong size rather than hashing garbage", () => {
        // A short buffer would otherwise read undefined, produce NaN coefficients, and yield
        // a hash that is confidently wrong.
        expect(() => phashFromLuma(new Uint8Array(10))).toThrow();
    });

    describe("survives changes that preserve what the picture looks like", () => {
        const original = phashFromLuma(photograph).hash;

        it("brightness shift", () => {
            const brighter = render((x, y) => Math.min(255, photograph[y * size + x] + 30));

            expect(hammingDistance(original, phashFromLuma(brighter).hash)).toBeLessThanOrEqual(2);
        });

        it("contrast change", () => {
            const flatter = render((x, y) => 128 + (photograph[y * size + x] - 128) * 0.6);

            expect(hammingDistance(original, phashFromLuma(flatter).hash)).toBeLessThanOrEqual(2);
        });

        it("compression-like noise", () => {
            // Deterministic pseudo-noise, so a failure is reproducible rather than flaky.
            const noisy = render(
                (x, y) => photograph[y * size + x] + (((x * 7 + y * 13) % 11) - 5)
            );

            expect(hammingDistance(original, phashFromLuma(noisy).hash)).toBeLessThanOrEqual(4);
        });

        it("halved resolution", () => {
            expect(
                hammingDistance(original, phashFromLuma(halfResolution(photograph)).hash)
            ).toBeLessThanOrEqual(PHASH_MAX_INDEXED_DISTANCE);
        });
    });

    it("separates genuinely different pictures", () => {
        // Without this, every assertion above would also pass for a hash that returned a
        // constant.
        expect(
            hammingDistance(phashFromLuma(photograph).hash, phashFromLuma(differentPhotograph).hash)
        ).toBeGreaterThan(PHASH_MAX_INDEXED_DISTANCE);
    });

    it("is not dominated by overall brightness", () => {
        // The DC term is an order of magnitude larger than every other coefficient, so
        // including it in the median would push most bits to zero and make any two dark
        // images look alike. These two differ only in brightness *pattern*, not level.
        const darkA = render((x, _y) => 20 + 10 * Math.sin((x / size) * Math.PI * 2));
        const darkB = render((_x, y) => 20 + 10 * Math.sin((y / size) * Math.PI * 2));

        expect(
            hammingDistance(phashFromLuma(darkA).hash, phashFromLuma(darkB).hash)
        ).toBeGreaterThan(PHASH_MAX_INDEXED_DISTANCE);
    });
});

describe("hammingDistance", () => {
    it("is zero for identical hashes", () => {
        expect(
            hammingDistance(phashFromLuma(photograph).hash, phashFromLuma(photograph).hash)
        ).toBe(0);
    });

    it("counts every differing bit", () => {
        const a = new Uint8Array(PHASH_BYTES);
        const b = new Uint8Array(PHASH_BYTES).fill(0xff);

        expect(hammingDistance(a, b)).toBe(PHASH_BITS);
    });

    it("excludes a malformed row instead of throwing", () => {
        // This runs inside a candidate loop over database rows; one bad row must not abort a
        // clustering pass over the whole library.
        expect(hammingDistance(new Uint8Array(4), new Uint8Array(8))).toBeGreaterThan(PHASH_BITS);
    });
});

describe("hashBands", () => {
    it("splits the hash into the indexed bands", () => {
        const bands = hashBands(phashFromLuma(photograph).hash);

        expect(bands).toHaveLength(PHASH_BANDS);
        expect(PHASH_BANDS * PHASH_BAND_BITS).toBe(PHASH_BITS);
    });

    it("keeps every band inside its bit width", () => {
        for (const band of hashBands(new Uint8Array(PHASH_BYTES).fill(0xff))) {
            expect(band).toBeLessThan(2 ** PHASH_BAND_BITS);
            expect(band).toBeGreaterThanOrEqual(0);
        }
    });

    /**
     * The guarantee the whole candidate index rests on.
     *
     * With B bands, two hashes differing in at most B-1 bits must share a band, because the
     * differing bits cannot cover every band. This is exhaustive over placements for small
     * distances and random beyond, because it is the one property whose failure is silent —
     * a missed pair is simply a duplicate that stays in the library forever.
     */
    it("guarantees a shared band for any pair within the indexed distance", () => {
        const base = phashFromLuma(photograph).hash;

        const flip = (hash: Uint8Array, bits: number[]): Uint8Array => {
            const copy = new Uint8Array(hash);

            for (const bit of bits) {
                copy[bit >> 3] ^= 0x80 >> (bit & 7);
            }

            return copy;
        };

        for (let trial = 0; trial < 3_000; trial += 1) {
            const distance = 1 + (trial % PHASH_MAX_INDEXED_DISTANCE);
            const bits = new Set<number>();

            // Deterministic bit choices, so a failure can be reproduced exactly.
            let seed = trial * 2_654_435_761;

            while (bits.size < distance) {
                seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
                // The high bits, not the low ones: in a power-of-two LCG the low bits have a
                // very short period, so `seed % 64` cycles through a handful of values and
                // this loop never collects enough distinct bits to terminate.
                bits.add((seed >>> 13) % PHASH_BITS);
            }

            const other = flip(base, [...bits]);

            expect(hammingDistance(base, other)).toBe(distance);

            const baseBands = hashBands(base);
            const otherBands = hashBands(other);
            const shared = baseBands.filter((band, index) => band === otherBands[index]);

            expect(shared.length).toBeGreaterThan(0);
        }
    });

    it("rejects a hash of the wrong length", () => {
        expect(() => hashBands(new Uint8Array(4))).toThrow();
    });
});

describe("hex round-trip", () => {
    it("survives the database and back", () => {
        const hash = phashFromLuma(photograph).hash;

        expect(hashToHex(hashFromHex(hashToHex(hash)))).toBe(hashToHex(hash));
    });

    it("rejects the wrong length rather than padding", () => {
        expect(() => hashFromHex("abcd")).toThrow();
    });
});

describe("flat frames", () => {
    it("flags a blank frame", () => {
        // Fades to black and letterbox bars are everywhere in a video library. Their AC
        // coefficients are floating-point dust, so the median sits in the dust too and the
        // resulting hash is unstable noise -- two identical black frames would hash
        // differently, and unrelated ones would occasionally collide.
        expect(phashFromLuma(render(() => 0)).flat).toBe(true);
        expect(phashFromLuma(render(() => 255)).flat).toBe(true);
        expect(phashFromLuma(render(() => 17)).flat).toBe(true);
    });

    it("flags a frame with a single flat gradient step", () => {
        // A letterboxed bar against a near-uniform background still carries almost nothing.
        expect(phashFromLuma(render((_x, y) => (y < 2 ? 0 : 1))).flat).toBe(true);
    });

    it("accepts an ordinary picture", () => {
        expect(phashFromLuma(photograph).flat).toBe(false);
        expect(phashFromLuma(differentPhotograph).flat).toBe(false);
    });

    it("accepts a dim but structured picture", () => {
        // Dim is not blank, and discarding dim frames would lose whole night-time scenes.
        const dim = render(
            (x, y) =>
                60 + 8 * Math.sin((x / size) * Math.PI * 2) + 6 * Math.cos((y / size) * Math.PI * 3)
        );

        expect(phashFromLuma(dim).flat).toBe(false);
    });
});
