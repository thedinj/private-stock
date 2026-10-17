import { ValidationError } from "./errors.js";

/**
 * Tile prints: the second, offset-tolerant test for duplicate videos (§10h).
 *
 * The perceptual hash samples twelve frames at fractions of each file's own length, so two
 * copies of one video that differ by a second and a half of lead-in are sampled at different
 * moments, and in moving footage a few hundred milliseconds is already 12–30 bits. A tile print
 * is read from the sprite sheet instead, which is cut on a whole-second grid from zero: copies of
 * similar length get the same grid, an offset stays constant instead of drifting, and the tiles
 * mostly land on the scene-cut keyframes both encodes share. Lining the two sequences up over a
 * small shift is then enough.
 *
 * The print of one tile is the tile shrunk to a 4×4 grid of average colours. It was chosen by
 * measurement on the live library against six other signals, CLIP vectors among them: coarse
 * enough to survive the shift, specific enough that no random or look-alike pair in the sample
 * came near the threshold (§10h has the numbers). Pure, so every decision here is testable
 * without decoding anything.
 */

/** Side each tile is scaled to before it is reduced, which is also what flatness is read at. */
export const TILE_PRINT_SIDE = 32;

/** Cells per side of the print. */
export const TILE_PRINT_GRID = 4;

export const TILE_PRINT_BYTES = TILE_PRINT_GRID * TILE_PRINT_GRID * 3;

/**
 * Luma standard deviation below which a tile carries no signal.
 *
 * Fades and black frames, for the reason the perceptual hash skips them (§10): every copy of
 * every video has them, and correlating noise around a flat mean manufactures matches.
 */
export const TILE_FLAT_STD = 6;

/** Pearson correlation of two prints at or above which the tiles are the same picture. */
export const TILE_MATCH_CORRELATION = 0.85;

/**
 * Fraction of the shorter video's tiles that must match for the pair to be duplicates.
 *
 * Low on purpose, and safe low: tiles jitter between encodes because each snaps to the nearest
 * keyframe, so a true pair offset by 1.5 s scored 0.46, while the worst of 771 negatives scored
 * 0.19 and the worst look-alike 0.07.
 */
export const TILE_MATCH_RATIO = 0.3;

/** Shifts tried either side of aligned, in tiles. Each also looks one tile either side. */
export const TILE_MAX_SHIFT = 1;

/**
 * How far apart two durations may be for the pair to be worth lining up.
 *
 * Every pair the perceptual hash confirmed on the live library was within 0.96%. The floor is
 * for short videos, where a second of lead-in is more than one percent.
 */
export const TILE_DURATION_FRACTION = 0.01;
export const TILE_DURATION_FLOOR_MS = 2_000;

export interface TilePrints {
    /** The sprite interval the tiles were cut at; tile `i` is at `i * intervalMs`. */
    intervalMs: number;
    /** One print per tile, or null for a flat one. */
    tiles: (Uint8Array | null)[];
}

/**
 * The print of one tile from its pixels: `TILE_PRINT_SIDE` square, packed RGB.
 *
 * Null for a flat tile. The flatness is read from the full square rather than from the 4×4
 * print, so a tile with real but fine detail still counts.
 */
export const tilePrintFromRgb = (rgb: Uint8Array): Uint8Array | null => {
    const side = TILE_PRINT_SIDE;
    const cell = side / TILE_PRINT_GRID;
    const sums = new Float64Array(TILE_PRINT_BYTES);
    let lumaSum = 0;
    let lumaSquares = 0;

    for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
            const at = (y * side + x) * 3;
            const target = (Math.floor(y / cell) * TILE_PRINT_GRID + Math.floor(x / cell)) * 3;
            const luma = 0.299 * rgb[at] + 0.587 * rgb[at + 1] + 0.114 * rgb[at + 2];

            sums[target] += rgb[at];
            sums[target + 1] += rgb[at + 1];
            sums[target + 2] += rgb[at + 2];
            lumaSum += luma;
            lumaSquares += luma * luma;
        }
    }

    const pixels = side * side;
    const mean = lumaSum / pixels;

    if (Math.sqrt(Math.max(0, lumaSquares / pixels - mean * mean)) < TILE_FLAT_STD) {
        return null;
    }

    return Uint8Array.from(sums, (sum) => Math.round(sum / (cell * cell)));
};

/** Whether two videos are close enough in length for their tiles to be lined up. */
export const durationsComparable = (aMs: number, bMs: number): boolean =>
    Math.abs(aMs - bMs) <=
    Math.max(TILE_DURATION_FLOOR_MS, Math.max(aMs, bMs) * TILE_DURATION_FRACTION);

/** A print centred and scaled to unit length, so a correlation is one dot product. */
const normalised = (print: Uint8Array): Float32Array | null => {
    let mean = 0;

    for (const value of print) {
        mean += value;
    }

    mean /= print.length;

    const out = new Float32Array(print.length);
    let norm = 0;

    for (let i = 0; i < print.length; i += 1) {
        out[i] = print[i] - mean;
        norm += out[i] * out[i];
    }

    if (norm === 0) {
        return null;
    }

    const scale = 1 / Math.sqrt(norm);

    for (let i = 0; i < out.length; i += 1) {
        out[i] *= scale;
    }

    return out;
};

/** Prints ready for `alignTilePrints`, prepared once per video rather than once per pair. */
export interface PreparedTilePrints {
    intervalMs: number;
    tiles: (Float32Array | null)[];
}

export const prepareTilePrints = (prints: TilePrints): PreparedTilePrints => ({
    intervalMs: prints.intervalMs,
    tiles: prints.tiles.map((print) => (print ? normalised(print) : null)),
});

const correlation = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;

    for (let i = 0; i < a.length; i += 1) {
        sum += a[i] * b[i];
    }

    return sum;
};

export interface TileAlignment {
    /** Fraction of the shorter video's non-flat tiles that matched at the best shift. */
    score: number;
    matching: number;
    /** The best shift, in tiles of the shorter video's partner. */
    shift: number;
}

/**
 * How well two videos' tiles line up, at the best of a few small shifts.
 *
 * Tiles are paired by time rather than by index, so two videos whose lengths straddle a
 * whole-second boundary in the sprite layout — and so were cut at different intervals — still
 * pair moment with moment. At each shift a tile matches if any of the three partners around its
 * moment correlates above the threshold: tiles snap to keyframes, so the right partner is
 * sometimes the neighbour.
 *
 * Measured against the video with fewer tiles, as `compareVideos` measures against the shorter
 * side. A tile is left out of the count when it is flat, or when every partner it has is.
 */
export const alignTilePrints = (
    first: PreparedTilePrints,
    second: PreparedTilePrints
): TileAlignment => {
    const [a, b] = first.tiles.length <= second.tiles.length ? [first, second] : [second, first];
    let best: TileAlignment = { score: 0, matching: 0, shift: 0 };

    if (a.tiles.length === 0 || b.tiles.length === 0 || a.intervalMs <= 0 || b.intervalMs <= 0) {
        return best;
    }

    for (let shift = -TILE_MAX_SHIFT; shift <= TILE_MAX_SHIFT; shift += 1) {
        let matching = 0;
        let counted = 0;

        for (let i = 0; i < a.tiles.length; i += 1) {
            const tile = a.tiles[i];

            if (!tile) {
                continue;
            }

            const centre = Math.round((i * a.intervalMs) / b.intervalMs) + shift;
            let partners = 0;
            let usable = 0;
            let matched = false;

            for (let j = centre - 1; j <= centre + 1; j += 1) {
                if (j < 0 || j >= b.tiles.length) {
                    continue;
                }

                partners += 1;

                const other = b.tiles[j];

                if (!other) {
                    continue;
                }

                usable += 1;

                if (correlation(tile, other) >= TILE_MATCH_CORRELATION) {
                    matched = true;
                    break;
                }
            }

            if (partners > 0 && usable === 0) {
                continue;
            }

            counted += 1;

            if (matched) {
                matching += 1;
            }
        }

        const score = counted === 0 ? 0 : matching / counted;

        if (score > best.score) {
            best = { score, matching, shift };
        }
    }

    return best;
};

/** Whether an alignment makes the two videos duplicates. */
export const tilesMatch = (alignment: TileAlignment, minMatchingTiles: number): boolean =>
    alignment.score >= TILE_MATCH_RATIO && alignment.matching >= minMatchingTiles;

/**
 * The file format: `PSTP`, a format byte, the interval, the tile count, then per tile a flag
 * byte (1 for flat) and its print. Flat tiles keep their slot, so index still means time.
 */
const MAGIC = [0x50, 0x53, 0x54, 0x50];
const FORMAT = 1;
const HEADER_BYTES = 4 + 1 + 4 + 4;
const ENTRY_BYTES = 1 + TILE_PRINT_BYTES;

export const encodeTilePrints = (prints: TilePrints): Uint8Array => {
    const bytes = new Uint8Array(HEADER_BYTES + prints.tiles.length * ENTRY_BYTES);
    const view = new DataView(bytes.buffer);

    bytes.set(MAGIC, 0);
    bytes[4] = FORMAT;
    view.setUint32(5, prints.intervalMs, true);
    view.setUint32(9, prints.tiles.length, true);

    prints.tiles.forEach((print, index) => {
        const at = HEADER_BYTES + index * ENTRY_BYTES;

        if (print) {
            bytes.set(print, at + 1);
        } else {
            bytes[at] = 1;
        }
    });

    return bytes;
};

export const decodeTilePrints = (bytes: Uint8Array): TilePrints => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (
        bytes.length < HEADER_BYTES ||
        MAGIC.some((value, index) => bytes[index] !== value) ||
        bytes[4] !== FORMAT
    ) {
        throw new ValidationError("Not a tile prints file this version can read");
    }

    const count = view.getUint32(9, true);

    if (bytes.length !== HEADER_BYTES + count * ENTRY_BYTES) {
        throw new ValidationError("Tile prints file is truncated");
    }

    return {
        intervalMs: view.getUint32(5, true),
        tiles: Array.from({ length: count }, (_, index) => {
            const at = HEADER_BYTES + index * ENTRY_BYTES;

            return bytes[at] === 1 ? null : bytes.slice(at + 1, at + ENTRY_BYTES);
        }),
    };
};
