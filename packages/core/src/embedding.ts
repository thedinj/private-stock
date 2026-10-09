/**
 * The arithmetic of embedding a frame (§5e): which squares of it the model sees, how their
 * pixels are prepared, which moments are worth keeping, and the bytes they are stored as.
 *
 * Pure and dependency-free so it can be tested without a model, and so the web app can read the
 * same file format the worker writes. The model itself is run elsewhere — `core/server` opens it,
 * the worker's embedder child feeds it.
 */

import { ValidationError } from "./errors.js";

/** The side of the square CLIP ViT-B/32 sees. */
export const EMBED_SIDE = 224;

/** Numbers per vector. */
export const EMBED_DIMS = 512;

/** CLIP's own normalisation, from the model's preprocessor configuration. */
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

/**
 * How far from square a frame may be and still be seen whole, as one centred square.
 *
 * Beyond it a frame is covered by several squares instead (§5e "Two squares"). The library is
 * mostly 9:16 phone video and 16:9 everything else, and a single centred square of either loses
 * a fifth at each end — on a vertical video, usually the part with the face in it.
 */
export const SQUARE_TOLERANCE = 1.2;

/** Two cover 16:9 and 9:16 with overlap; three cover anything up to 3:1; wider is cropped. */
export const MAX_SQUARES = 3;

/**
 * Consecutive moments at least this similar are one moment (§5e "Embed the sprite frames").
 *
 * Measured on the library: 65% of sprite frames survive it. A static shot sampled every few
 * seconds is the same vector many times over, and keeping each copy costs disk and search time
 * for no result anybody would see.
 */
export const THIN_SIMILARITY = 0.95;

/** Representatives per item in the in-memory index (§5e "Search runs in two passes"). */
export const MAX_REPRESENTATIVES = 8;

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * The squares a frame is seen as: one when it is near square, otherwise evenly spaced along its
 * long side from one end to the other, so together they cover it.
 */
export const squaresIn = (rect: Rect): Rect[] => {
    const long = Math.max(rect.width, rect.height);
    const side = Math.min(rect.width, rect.height);

    if (side <= 0) {
        return [];
    }

    const tall = rect.height > rect.width;
    const count =
        long <= side * SQUARE_TOLERANCE ? 1 : Math.min(MAX_SQUARES, Math.ceil(long / side - 1e-9));
    const span = long - side;

    return Array.from({ length: count }, (_, index) => {
        // One square sits in the middle; several run from one end to the other.
        const along = count === 1 ? span / 2 : (span * index) / (count - 1);

        return tall
            ? { x: rect.x, y: rect.y + along, width: side, height: side }
            : { x: rect.x + along, y: rect.y, width: side, height: side };
    });
};

/**
 * Write one square of an RGB image into a model input, as CLIP expects it.
 *
 * Resampled to `EMBED_SIDE`: averaged over each output pixel's footprint when shrinking — a cover
 * is ~640 px wide, and point sampling it down by three would alias — and bilinear when
 * enlarging, which is a 200 px sprite tile. Then CLIP's mean and deviation, channel-planar.
 */
export const writeModelInput = (
    rgb: Uint8Array,
    imageWidth: number,
    imageHeight: number,
    square: Rect,
    out: Float32Array,
    offset: number
): void => {
    const plane = EMBED_SIDE * EMBED_SIDE;
    const scale = square.width / EMBED_SIDE;
    const at = (x: number, y: number, channel: number): number => {
        const cx = Math.min(imageWidth - 1, Math.max(0, x));
        const cy = Math.min(imageHeight - 1, Math.max(0, y));

        return rgb[(cy * imageWidth + cx) * 3 + channel];
    };

    for (let oy = 0; oy < EMBED_SIDE; oy += 1) {
        for (let ox = 0; ox < EMBED_SIDE; ox += 1) {
            const sx = square.x + ox * scale;
            const sy = square.y + oy * scale;

            for (let channel = 0; channel < 3; channel += 1) {
                let value: number;

                if (scale > 1) {
                    let sum = 0;
                    let count = 0;

                    for (let y = Math.floor(sy); y < Math.ceil(sy + scale); y += 1) {
                        for (let x = Math.floor(sx); x < Math.ceil(sx + scale); x += 1) {
                            sum += at(x, y, channel);
                            count += 1;
                        }
                    }

                    value = sum / count;
                } else {
                    const fx = sx + scale / 2 - 0.5;
                    const fy = sy + scale / 2 - 0.5;
                    const x0 = Math.floor(fx);
                    const y0 = Math.floor(fy);
                    const ax = fx - x0;
                    const ay = fy - y0;

                    value =
                        (at(x0, y0, channel) * (1 - ax) + at(x0 + 1, y0, channel) * ax) * (1 - ay) +
                        (at(x0, y0 + 1, channel) * (1 - ax) + at(x0 + 1, y0 + 1, channel) * ax) *
                            ay;
                }

                out[offset + channel * plane + oy * EMBED_SIDE + ox] =
                    (value / 255 - CLIP_MEAN[channel]) / CLIP_STD[channel];
            }
        }
    }
};

export const normaliseVector = (vector: Float32Array): Float32Array => {
    let sum = 0;

    for (const value of vector) sum += value * value;

    const length = Math.sqrt(sum) || 1;

    return vector.map((value) => value / length);
};

/** Cosine similarity of two unit vectors. */
export const vectorSimilarity = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;

    for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];

    return sum;
};

/**
 * Cosine similarity of a unit vector and a stored one, without dequantizing it first.
 *
 * `offset` is where the stored vector starts in `values`, so a run of them kept end to end — the
 * web process's index of representatives — is scored in place. Approximately cosine: a stored
 * vector's length is one only to within its rounding, which is far below anything a ranking can
 * see.
 */
export const quantizedSimilarity = (
    query: Float32Array,
    values: Int8Array,
    scale: number,
    offset = 0
): number => {
    let sum = 0;

    for (let i = 0; i < query.length; i += 1) sum += query[i] * values[offset + i];

    return sum * scale;
};

/** The direction of several unit vectors together: their sum, made unit length. */
export const meanDirection = (vectors: Float32Array[]): Float32Array => {
    const sum = new Float32Array(vectors[0]?.length ?? EMBED_DIMS);

    for (const vector of vectors) {
        for (let i = 0; i < sum.length; i += 1) sum[i] += vector[i];
    }

    return normaliseVector(sum);
};

/**
 * The phrasings a look asked for in words is encoded as, and averaged (§5e "Search runs in two
 * passes").
 *
 * The words alone, and as CLIP's training captions put them: the prompt ensembling CLIP's authors
 * recommend, since the caption form is what the text model saw millions of times. The blind review
 * of the library's own 31 searches was run this way; neither phrasing alone was measured. Lowercased
 * in the caption, where a capital would be mid-sentence.
 */
export const lookPhrasings = (text: string): string[] => [text, `a photo of ${text.toLowerCase()}`];

/** One sampled moment: the vectors of its squares, in order along the frame. */
export interface Moment {
    /** Where in the video; null for a photograph. */
    atMs: number | null;
    vectors: Float32Array[];
}

/**
 * Which moments to keep: each one that differs from the last one kept.
 *
 * A moment differs if any of its squares does — the bottom of a vertical frame can change while
 * the top holds still. Compared with the last *kept* moment rather than the previous one, so a
 * slow pan cannot creep past the threshold a frame at a time without ever being recorded.
 */
export const thinMoments = (moments: Moment[], threshold = THIN_SIMILARITY): number[] => {
    const kept: number[] = [];

    moments.forEach((moment, index) => {
        const last = kept.length > 0 ? moments[kept[kept.length - 1]] : null;
        const differs =
            last === null ||
            last.vectors.length !== moment.vectors.length ||
            moment.vectors.some(
                (vector, square) => vectorSimilarity(vector, last.vectors[square]) < threshold
            );

        if (differs) {
            kept.push(index);
        }
    });

    return kept;
};

/**
 * Up to `count` vectors chosen to be as unlike each other as possible: the first, then each time
 * the one least like any already chosen.
 *
 * Real frames rather than averages, which the bake-off settled (§5e): an average of a long
 * video dilutes the one strong moment that is usually why it should be found.
 */
export const farthestPoints = (vectors: Float32Array[], count = MAX_REPRESENTATIVES): number[] => {
    if (vectors.length === 0) {
        return [];
    }

    const chosen = [0];
    const closest = vectors.map((vector) => vectorSimilarity(vector, vectors[0]));

    while (chosen.length < Math.min(count, vectors.length)) {
        let pick = -1;

        closest.forEach((value, index) => {
            if (!chosen.includes(index) && (pick === -1 || value < closest[pick])) {
                pick = index;
            }
        });

        chosen.push(pick);
        vectors.forEach((vector, index) => {
            closest[index] = Math.max(closest[index], vectorSimilarity(vector, vectors[pick]));
        });
    }

    return chosen;
};

/** A vector stored at eight bits: each value is `values[i] * scale`. */
export interface Quantized {
    values: Int8Array;
    scale: number;
}

/** Per-vector scaling, so a vector's largest value uses the whole range. */
export const quantize = (vector: Float32Array): Quantized => {
    let largest = 0;

    for (const value of vector) largest = Math.max(largest, Math.abs(value));

    const scale = largest / 127 || 1;

    return { values: Int8Array.from(vector, (value) => Math.round(value / scale)), scale };
};

export const dequantize = ({ values, scale }: Quantized): Float32Array =>
    Float32Array.from(values, (value) => value * scale);

/** One stored vector with where it came from. */
export interface StoredVector {
    atMs: number | null;
    /** Which square of the frame, counted along its long side. */
    square: number;
    vector: Quantized;
}

/** An item's vectors file, `embed/<xx>/<mediaId>.vec`. */
export interface VectorFile {
    model: string;
    stageVersion: number;
    dims: number;
    vectors: StoredVector[];
    /** Indices into `vectors`: the item's entries in the in-memory index. */
    representatives: number[];
}

const MAGIC = [0x50, 0x53, 0x56, 0x45]; // "PSVE"
const FORMAT = 1;
/** Per vector: atMs (int32, -1 for none), square (uint8), scale (float32). */
const ENTRY_BYTES = 9;

/**
 * Bytes on disk: magic and format, a JSON header, a table of entries, then the vectors.
 *
 * The header is JSON because it is small and will grow; the vectors are raw because they are
 * the bulk — ~40 KB for an ordinary video at 512 dimensions and eight bits.
 */
export const encodeVectorFile = (file: VectorFile): Uint8Array => {
    const header = new TextEncoder().encode(
        JSON.stringify({
            model: file.model,
            stageVersion: file.stageVersion,
            dims: file.dims,
            count: file.vectors.length,
            representatives: file.representatives,
        })
    );
    const total = 9 + header.length + file.vectors.length * (ENTRY_BYTES + file.dims);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);

    bytes.set(MAGIC, 0);
    bytes[4] = FORMAT;
    view.setUint32(5, header.length, true);
    bytes.set(header, 9);

    let at = 9 + header.length;

    for (const entry of file.vectors) {
        view.setInt32(at, entry.atMs ?? -1, true);
        bytes[at + 4] = entry.square;
        view.setFloat32(at + 5, entry.vector.scale, true);
        at += ENTRY_BYTES;
    }

    for (const entry of file.vectors) {
        bytes.set(
            new Uint8Array(entry.vector.values.buffer, entry.vector.values.byteOffset, file.dims),
            at
        );
        at += file.dims;
    }

    return bytes;
};

export const decodeVectorFile = (bytes: Uint8Array): VectorFile => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (MAGIC.some((value, index) => bytes[index] !== value) || bytes[4] !== FORMAT) {
        throw new ValidationError("Not a vectors file this version can read");
    }

    const headerLength = view.getUint32(5, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + headerLength))) as {
        model: string;
        stageVersion: number;
        dims: number;
        count: number;
        representatives: number[];
    };

    let entry = 9 + headerLength;
    let data = entry + header.count * ENTRY_BYTES;
    const vectors: StoredVector[] = [];

    for (let i = 0; i < header.count; i += 1) {
        const atMs = view.getInt32(entry, true);

        vectors.push({
            atMs: atMs < 0 ? null : atMs,
            square: bytes[entry + 4],
            vector: {
                scale: view.getFloat32(entry + 5, true),
                values: new Int8Array(
                    bytes.buffer.slice(
                        bytes.byteOffset + data,
                        bytes.byteOffset + data + header.dims
                    )
                ),
            },
        });
        entry += ENTRY_BYTES;
        data += header.dims;
    }

    return {
        model: header.model,
        stageVersion: header.stageVersion,
        dims: header.dims,
        vectors,
        representatives: header.representatives,
    };
};

/**
 * One item's representatives, as a record of `embed/reps.log` (§5e).
 *
 * The web process needs every item's representatives in memory and must not open thirteen
 * thousand files to get them, so the worker appends each item's here as it is embedded and the
 * reader keeps the last record per item. Length-prefixed so a record cut short by a crash is
 * recognisable and ignored rather than misread.
 */
export const encodeRepresentatives = (mediaId: string, file: VectorFile): Uint8Array => {
    const id = new TextEncoder().encode(mediaId);
    const chosen = file.representatives.map((index) => file.vectors[index]);
    const body = 1 + id.length + 2 + 2 + 1 + chosen.length * (ENTRY_BYTES + file.dims);
    const bytes = new Uint8Array(4 + body);
    const view = new DataView(bytes.buffer);

    view.setUint32(0, body, true);
    bytes[4] = id.length;
    bytes.set(id, 5);

    let at = 5 + id.length;

    view.setUint16(at, file.stageVersion, true);
    view.setUint16(at + 2, file.dims, true);
    bytes[at + 4] = chosen.length;
    at += 5;

    for (const entry of chosen) {
        view.setInt32(at, entry.atMs ?? -1, true);
        bytes[at + 4] = entry.square;
        view.setFloat32(at + 5, entry.vector.scale, true);
        bytes.set(
            new Uint8Array(entry.vector.values.buffer, entry.vector.values.byteOffset, file.dims),
            at + ENTRY_BYTES
        );
        at += ENTRY_BYTES + file.dims;
    }

    return bytes;
};

export interface RepresentativesRecord {
    mediaId: string;
    stageVersion: number;
    vectors: StoredVector[];
}

/**
 * Every complete record in a representatives log, in order, and how many bytes they took.
 *
 * A truncated tail is left out of both, so `length` is where the next read should start: a
 * record the worker is halfway through appending is read whole the next time, not skipped.
 *
 * The vectors are views into `bytes`, not copies. The one reader keeps them packed in arrays of
 * its own, and a copy per vector here was a second copy of the whole log on the way there --
 * ~35 MB the web process would have had to allocate and free at once, which glibc does not give
 * back (§5e "Memory").
 */
export const decodeRepresentatives = (
    bytes: Uint8Array
): { records: RepresentativesRecord[]; length: number } => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const records: RepresentativesRecord[] = [];
    let at = 0;

    while (at + 4 <= bytes.length) {
        const body = view.getUint32(at, true);

        if (at + 4 + body > bytes.length) {
            break;
        }

        let cursor = at + 4;
        const idLength = bytes[cursor];
        const mediaId = new TextDecoder().decode(bytes.subarray(cursor + 1, cursor + 1 + idLength));

        cursor += 1 + idLength;

        const stageVersion = view.getUint16(cursor, true);
        const dims = view.getUint16(cursor + 2, true);
        const count = bytes[cursor + 4];
        const vectors: StoredVector[] = [];

        cursor += 5;

        for (let i = 0; i < count; i += 1) {
            const atMs = view.getInt32(cursor, true);

            vectors.push({
                atMs: atMs < 0 ? null : atMs,
                square: bytes[cursor + 4],
                vector: {
                    scale: view.getFloat32(cursor + 5, true),
                    values: new Int8Array(
                        bytes.buffer,
                        bytes.byteOffset + cursor + ENTRY_BYTES,
                        dims
                    ),
                },
            });
            cursor += ENTRY_BYTES + dims;
        }

        records.push({ mediaId, stageVersion, vectors });
        at += 4 + body;
    }

    return { records, length: at };
};
