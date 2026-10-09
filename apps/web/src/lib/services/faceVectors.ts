import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
    assertSafeRelativePath,
    decodeVectorFile,
    dequantize,
    faceFileRelPath,
    normaliseVector,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/**
 * Faces' vectors, read from their items' faces files (§5f): unit length, or null where the file is
 * gone or does not hold the face — a re-run under way, or an item the sweep has yet to repair.
 *
 * A reader per request: each file is read once however many of its faces are asked about, and
 * nothing outlives the request, so a re-run of the stage is never answered from an older file.
 */
export const faceVectorReader = (): ((
    mediaId: string,
    vectorIndex: number
) => Float32Array | null) => {
    const files = new Map<string, Float32Array[] | null>();

    const vectorsOf = (mediaId: string): Float32Array[] | null => {
        if (files.has(mediaId)) return files.get(mediaId)!;

        let vectors: Float32Array[] | null = null;

        try {
            const file = decodeVectorFile(
                new Uint8Array(
                    readFileSync(
                        path.resolve(
                            loadConfig().dataDir,
                            assertSafeRelativePath(faceFileRelPath(mediaId))
                        )
                    )
                )
            );

            vectors = file.vectors.map((entry) => normaliseVector(dequantize(entry.vector)));
        } catch {
            vectors = null;
        }

        files.set(mediaId, vectors);

        return vectors;
    };

    return (mediaId, vectorIndex) => vectorsOf(mediaId)?.[vectorIndex] ?? null;
};
