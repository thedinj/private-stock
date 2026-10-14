import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
    assertSafeRelativePath,
    decodeVectorFile,
    dequantize,
    faceFileRelPath,
    normaliseVector,
    type Quantized,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/** A file under the data directory, by its path relative to it. */
export const dataFile = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

/**
 * An item's face vectors, by `vectorIndex`, as stored -- a byte a dimension; null when its file
 * cannot be read (§5f). What the references job keeps between runs: a whole library's faces are
 * some 40 MB this way, four times that unpacked.
 */
export const readStoredFaces = async (mediaId: string): Promise<Quantized[] | null> => {
    try {
        return decodeVectorFile(
            new Uint8Array(await readFile(dataFile(faceFileRelPath(mediaId))))
        ).vectors.map((entry) => entry.vector);
    } catch {
        return null;
    }
};

/** A stored face vector unpacked to unit length: what every comparison of faces is made with. */
export const unitFace = (stored: Quantized): Float32Array => normaliseVector(dequantize(stored));
