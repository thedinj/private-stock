/**
 * Perceptual hashing for duplicate detection (§10).
 *
 * A 64-bit DCT hash: two pictures that look the same to a person produce hashes a few bits
 * apart, regardless of resolution, re-encoding, or moderate brightness changes. That is the
 * property a library of 200k files needs, because the same scene arrives repeatedly as a
 * 1080p original, a 720p re-encode, and a screenshot of the same frame — none of which share
 * a byte, so `contentHash` sees three unrelated files.
 *
 * Pure, and deliberately kept away from any image library: the input is a grayscale pixel
 * array, which ffmpeg produces for both stills and video frames. That makes every decision
 * here testable against synthetic images with no decoding, no fixtures and no I/O.
 */

/** Side of the grayscale image the hash is computed from. */
export const PHASH_SIZE = 32;

/**
 * Side of the low-frequency block kept from the DCT.
 *
 * 8x8 of a 32x32 transform is the coarse structure of the picture — the part that survives
 * rescaling and re-encoding. Keeping more would make the hash sensitive to exactly the
 * high-frequency detail that a different encoder throws away, which is the same as making it
 * sensitive to the encoder.
 */
export const PHASH_BLOCK = 8;

export const PHASH_BITS = PHASH_BLOCK * PHASH_BLOCK;
export const PHASH_BYTES = PHASH_BITS / 8;

/**
 * The band index (§10).
 *
 * Candidates are found by exact match on a band rather than by scanning every hash, and the
 * guarantee that makes it sound is pigeonhole: if two hashes differ in at most D bits and
 * the hash is cut into B bands, then with D < B at least one band must be free of differing
 * bits, so an equality lookup on that band is certain to surface the pair.
 *
 * **The guarantee is D < B, not D < bits-per-band.** An earlier version of §10 specified
 * four 16-bit bands and claimed recall to distance 8; four bands in fact guarantee only
 * distance 3, and at distance 8 roughly 70% of genuine near-duplicate pairs share no band at
 * all and would never be compared. Nothing about that failure is visible — the review queue
 * simply looks emptier than the library deserves.
 *
 * Eight 8-bit bands guarantee distance 7, which covers ordinary re-encodes and rescales. The
 * cost is selectivity: a 1-byte band has 256 buckets, so a lookup on a 200k-row table
 * returns a few hundred rows per band rather than a handful. That is the right trade, since
 * each candidate costs one XOR and a popcount, while a missed duplicate costs a duplicate
 * kept forever.
 */
export const PHASH_BANDS = 8;
export const PHASH_BAND_BITS = PHASH_BITS / PHASH_BANDS;

/**
 * The largest distance the band index is guaranteed to find.
 *
 * Any threshold above this silently loses recall rather than failing, so it is exported as a
 * hard ceiling and the settings schema clamps to it.
 */
export const PHASH_MAX_INDEXED_DISTANCE = PHASH_BANDS - 1;

/**
 * Default "these are the same picture" threshold.
 *
 * Below the ceiling on purpose. At 7 the index is exact but the false-positive rate climbs,
 * and a review queue full of unrelated pictures is one nobody works through — which is worse
 * than a slightly shorter queue, because the whole feature depends on someone reading it.
 */
export const PHASH_DEFAULT_DISTANCE = 5;

/**
 * Cosine basis for the DCT, precomputed.
 *
 * The transform is O(n^3) done naively and runs once per image over a whole library, so the
 * cosines are computed once rather than 32^3 times per image. At 32x32 this is a 1024-entry
 * table.
 */
const COS_TABLE = (() => {
    const table = new Float64Array(PHASH_SIZE * PHASH_SIZE);

    for (let x = 0; x < PHASH_SIZE; x += 1) {
        for (let u = 0; u < PHASH_SIZE; u += 1) {
            table[x * PHASH_SIZE + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE));
        }
    }

    return table;
})();

/**
 * 2D DCT-II of a square grayscale image, returning only the top-left block.
 *
 * Separable: the 2D transform is the 1D transform applied to rows and then to columns, which
 * turns O(n^4) into O(n^3). Only the low-frequency block is ever read, so the column pass
 * computes just those rows.
 *
 * Orthonormal scaling is deliberately omitted. Every coefficient would be multiplied by the
 * same constants, and the hash compares coefficients against their own median — a uniform
 * scale factor cancels, so computing it would be arithmetic with no effect on the output.
 */
export const dctBlock = (pixels: ArrayLike<number>, size = PHASH_SIZE): Float64Array => {
    const rows = new Float64Array(size * PHASH_BLOCK);

    // Rows first: for each image row, the first PHASH_BLOCK frequency coefficients.
    for (let y = 0; y < size; y += 1) {
        for (let u = 0; u < PHASH_BLOCK; u += 1) {
            let sum = 0;

            for (let x = 0; x < size; x += 1) {
                sum += pixels[y * size + x] * COS_TABLE[x * size + u];
            }

            rows[y * PHASH_BLOCK + u] = sum;
        }
    }

    const block = new Float64Array(PHASH_BLOCK * PHASH_BLOCK);

    for (let v = 0; v < PHASH_BLOCK; v += 1) {
        for (let u = 0; u < PHASH_BLOCK; u += 1) {
            let sum = 0;

            for (let y = 0; y < size; y += 1) {
                sum += rows[y * PHASH_BLOCK + u] * COS_TABLE[y * size + v];
            }

            block[v * PHASH_BLOCK + u] = sum;
        }
    }

    return block;
};

/**
 * The median of the coefficients, excluding the DC term.
 *
 * Excluding `[0][0]` matters: it is the average brightness of the whole image and is an
 * order of magnitude larger than everything else, so including it drags the median far up
 * and most bits come out zero. Two unrelated dark photographs would then hash alike.
 *
 * The median rather than the mean, because it guarantees the hash is close to half ones —
 * the maximum-entropy split, and the reason Hamming distance is meaningful. A mean is pulled
 * by a handful of large coefficients and can produce a hash that is almost all zeros, where
 * every image looks near every other.
 */
const medianExcludingDc = (block: Float64Array): number => {
    const values = Array.from(block.slice(1)).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);

    // Dropping the DC term leaves 63 values, an *odd* count. Averaging the two middle
    // elements without flooring indexes the array at 30.5, which is `undefined`, which makes
    // the median NaN -- and every `coefficient > NaN` test is false, so the hash comes out
    // all zeros and every image in the library hashes identically to every other.
    return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

/**
 * How much signal an image must carry before its hash means anything.
 *
 * A flat frame -- a fade to black, a letterbox bar, a scanning placeholder -- has AC
 * coefficients that are exactly zero in theory and floating-point dust in practice, around
 * 1e-13. The median then sits in that dust, and roughly half the coefficients land above it
 * *by rounding*, so the hash is neither all-zeros nor stable: two identical black frames
 * produce different hashes, and unrelated ones occasionally collide.
 *
 * That is why flatness is measured from the transform rather than from the finished hash. A
 * bit-balance test on the hash looks like it would catch blank frames and does not catch
 * them at all, because the noise is balanced.
 *
 * The threshold is expressed per pixel so it is independent of `size`: the unnormalised DCT
 * sums over every pixel, so a coefficient scales with the pixel count. Half a grey level of
 * average amplitude is far below anything visible and far above rounding dust.
 */
const FLAT_AC_PER_PIXEL = 0.5;

export interface PerceptualHash {
    /**
     * 64 bits, as 8 bytes.
     *
     * A byte array rather than a number or a bigint: JavaScript numbers cannot hold 64 bits
     * exactly, and a silently-rounded hash would give a distance function that is wrong in a
     * way no test of small values would reveal. Bytes also go straight into the BLOB column
     * and come straight back out.
     */
    hash: Uint8Array;
    /**
     * Whether the image carries too little structure for the hash to mean anything.
     *
     * Callers must skip these rather than store them. Left in, blank frames cluster every
     * video in the library with every other one through their fades to black -- which is both
     * useless and the most expensive clustering pass it is possible to run.
     */
    flat: boolean;
}

/** The perceptual hash of a `size` x `size` grayscale image. */
export const phashFromLuma = (pixels: ArrayLike<number>, size = PHASH_SIZE): PerceptualHash => {
    if (pixels.length !== size * size) {
        throw new Error(`Expected ${size * size} grayscale samples, received ${pixels.length}`);
    }

    const block = dctBlock(pixels, size);
    const median = medianExcludingDc(block);
    const hash = new Uint8Array(PHASH_BYTES);

    let peakAc = 0;

    for (let i = 1; i < block.length; i += 1) {
        peakAc = Math.max(peakAc, Math.abs(block[i]));
    }

    for (let bit = 0; bit < PHASH_BITS; bit += 1) {
        /**
         * The DC term participates as a bit even though it was excluded from the median.
         *
         * It is always above a median computed without it, so bit 0 is always 1 — a constant
         * bit that contributes nothing and costs nothing. Skipping it instead would make the
         * hash 63 bits and stop it dividing evenly into bands, which is a real cost for no
         * gain.
         */
        if (block[bit] > median) {
            hash[bit >> 3] |= 0x80 >> (bit & 7);
        }
    }

    return { hash, flat: peakAc < size * size * FLAT_AC_PER_PIXEL };
};

/** Population count of a byte, by table — faster and clearer than a loop per bit. */
const POPCOUNT = (() => {
    const table = new Uint8Array(256);

    for (let i = 0; i < 256; i += 1) {
        table[i] = (i & 1) + table[i >> 1];
    }

    return table;
})();

/**
 * Bits that differ between two hashes.
 *
 * Returns `PHASH_BITS + 1` for mismatched lengths rather than throwing: this runs inside a
 * candidate loop over rows read from the database, and one malformed row must not abort a
 * clustering pass over the whole library. A distance above any possible threshold excludes
 * the pair, which is the safe reading of "this hash is unusable".
 */
export const hammingDistance = (a: Uint8Array, b: Uint8Array): number => {
    if (a.length !== b.length) {
        return PHASH_BITS + 1;
    }

    let distance = 0;

    for (let i = 0; i < a.length; i += 1) {
        distance += POPCOUNT[a[i] ^ b[i]];
    }

    return distance;
};

/**
 * The hash cut into band values, for the candidate index.
 *
 * Each band is a plain integer so it can be an indexed column and an equality lookup, which
 * is the only kind of query SQLite can answer quickly here. Returned in band order, matching
 * the `band0`..`band7` columns.
 */
export const hashBands = (hash: Uint8Array): number[] => {
    if (hash.length !== PHASH_BYTES) {
        throw new Error(`Expected a ${PHASH_BYTES}-byte hash, received ${hash.length}`);
    }

    const bytesPerBand = PHASH_BAND_BITS / 8;
    const bands: number[] = [];

    for (let band = 0; band < PHASH_BANDS; band += 1) {
        let value = 0;

        for (let byte = 0; byte < bytesPerBand; byte += 1) {
            value = value * 256 + hash[band * bytesPerBand + byte];
        }

        bands.push(value);
    }

    return bands;
};

/** Hex, for logs and for a readable failure message in a test. */
export const hashToHex = (hash: Uint8Array): string =>
    Array.from(hash)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

export const hashFromHex = (hex: string): Uint8Array => {
    if (hex.length !== PHASH_BYTES * 2) {
        throw new Error(`Expected ${PHASH_BYTES * 2} hex characters, received ${hex.length}`);
    }

    const hash = new Uint8Array(PHASH_BYTES);

    for (let i = 0; i < PHASH_BYTES; i += 1) {
        hash[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }

    return hash;
};
