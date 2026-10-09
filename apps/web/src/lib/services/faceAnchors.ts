import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import {
    FACE_ANCHORS_REL_PATH,
    assertSafeRelativePath,
    decodeFaceAnchors,
    type FaceAnchor,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

/**
 * Every library performer's face reference, as the `faceAnchors` job last wrote it (§5f "One face,
 * one score"): the one thing a face is scored against, in the review as in the worker.
 *
 * Kept while the file is unchanged — a few hundred references are a few hundred KB, read again
 * only when the job has written it anew. No file yet, or one this version cannot read, is no
 * references, and every row is scored against its own faces as before.
 */
let cached: { mtimeMs: number; anchors: Map<string, FaceAnchor> } | null = null;

export const faceAnchors = (): Map<string, FaceAnchor> => {
    const file = path.resolve(loadConfig().dataDir, assertSafeRelativePath(FACE_ANCHORS_REL_PATH));

    try {
        const { mtimeMs } = statSync(file);

        if (cached?.mtimeMs !== mtimeMs) {
            const anchors = decodeFaceAnchors(new Uint8Array(readFileSync(file)));

            cached = { mtimeMs, anchors: new Map(anchors.map((a) => [a.tagId, a])) };
        }

        return cached.anchors;
    } catch {
        return new Map();
    }
};
