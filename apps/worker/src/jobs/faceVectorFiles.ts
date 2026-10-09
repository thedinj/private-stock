import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
    assertSafeRelativePath,
    decodeVectorFile,
    dequantize,
    faceFileRelPath,
    normaliseVector,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/** A file under the data directory, by its path relative to it. */
export const dataFile = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

/**
 * An item's face vectors, by `vectorIndex`, unit length; null when its file cannot be read (§5f).
 * What the grouping job and the references job both read.
 */
export const readFaceVectors = async (mediaId: string): Promise<Float32Array[] | null> => {
    try {
        const file = decodeVectorFile(
            new Uint8Array(await readFile(dataFile(faceFileRelPath(mediaId))))
        );

        return file.vectors.map((entry) => normaliseVector(dequantize(entry.vector)));
    } catch {
        return null;
    }
};
