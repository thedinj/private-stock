import { readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
    FACE_SEARCH_RESULTS,
    SAME_PERSON_IN_ITEM,
    decodeVectorFile,
    findStage,
    nearestFaces,
    type StoredFaceSearch,
} from "@private-stock/core";
import { faceSearchRepo } from "@private-stock/db";

import { facesInChild } from "../embed/embedder.js";
import { extractFrame, imageDimensions } from "../media/frames.js";
import { resolveSource } from "../media/sourcePath.js";
import type { JobRow } from "../queue.js";
import { threadsPerJob } from "../throttle.js";
import { libraryFaces } from "./faceAnchors.js";
import { FACE_DETECTOR, FACE_RECOGNISER } from "./faces.js";
import { unitFace } from "./faceVectorFiles.js";

/**
 * The `faceSearch` job: who is this? (§5f "Who is this?")
 *
 * The frame somebody had on screen, read from the original at that moment — not the nearest sprite
 * tile, which is seldom the same frame and shows a face at a fifth of the size. Every face on it is
 * found and recognised with the `faces` stage's own models and code, and each is compared with
 * every face the library has stored, which the references run already holds in memory. Every face
 * on the frame is searched for at once, so choosing between them afterwards costs nothing.
 *
 * Requested work only, and so never held back by the model affinity (`embed/affinity.ts`). The
 * price is the face models' load when the child holds the other family or none — seconds, and
 * accepted: this is asked now and then, by somebody who wants that frame and no other.
 */

/** As wide as a capture keeps a frame (§13): the source's own pixels, up to a point. */
const FRAME_WIDTH = 2560;

/**
 * Kept per face on the frame, beyond the hundred shown: some may be in libraries the person
 * asking cannot see, which the web process leaves out.
 */
const KEPT_PER_FACE = Math.round(FACE_SEARCH_RESULTS * 1.5);

/** One search's frame, read and searched for. Exported for its integration test. */
export const searchFrame = async (
    absolutePath: string,
    search: { id: string; mediaId: string; atMs: number }
): Promise<StoredFaceSearch> => {
    // Wanted once, here, and not kept: outside the data directory, where no sweep must know them.
    const framePath = path.join(os.tmpdir(), `private-stock-face-search-${search.id}.webp`);
    const vectorsPath = path.join(os.tmpdir(), `private-stock-face-search-${search.id}.vec`);

    try {
        await extractFrame(absolutePath, framePath, {
            atMs: search.atMs,
            width: FRAME_WIDTH,
            quality: 95,
        });

        const { width, height } = await imageDimensions(framePath);

        if (!width || !height) {
            throw new Error("There is no frame at that moment");
        }

        const result = await facesInChild({
            detector: FACE_DETECTOR,
            recogniser: FACE_RECOGNISER,
            stageVersion: findStage("faces")!.version,
            threads: threadsPerJob(),
            sources: [
                {
                    absolutePath: framePath,
                    width,
                    height,
                    regions: [{ rect: { x: 0, y: 0, width, height }, atMs: search.atMs }],
                },
            ],
            outPath: vectorsPath,
        });

        if (result.faces.length === 0) {
            return [];
        }

        const vectors = decodeVectorFile(new Uint8Array(await readFile(vectorsPath))).vectors;
        const library = await libraryFaces();
        const own = library.get(search.mediaId);
        const round = (score: number) => Math.round(score * 1000) / 1000;

        return (
            result.faces
                .map((face) => {
                    const query = unitFace(vectors[face.vectorIndex]!.vector);
                    // Which of the item's own stored faces this is, so naming it confirms that
                    // person there too. The faces of one video share its light and grain, so the
                    // within-an-item line is the one to hold it to.
                    const [self] = own
                        ? nearestFaces(query, new Map([[search.mediaId, own]]), { count: 1 })
                        : [];

                    return {
                        x: face.x,
                        y: face.y,
                        w: face.w,
                        h: face.h,
                        self:
                            self && self.score >= SAME_PERSON_IN_ITEM
                                ? { vectorIndex: self.vectorIndex, score: round(self.score) }
                                : null,
                        matches: nearestFaces(query, library, {
                            count: KEPT_PER_FACE,
                            exclude: search.mediaId,
                        }).map((match) => ({ ...match, score: round(match.score) })),
                    };
                })
                // Left to right, so the numbers on the frame read in order.
                .sort((a, b) => a.x - b.x)
        );
    } finally {
        await rm(framePath, { force: true });
        await rm(vectorsPath, { force: true });
    }
};

export const runFaceSearch = async (job: JobRow, signal: AbortSignal): Promise<void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("faceSearch job requires both mediaId and fileId");
    }

    faceSearchRepo.resumeInterrupted(job.mediaId);

    const source = resolveSource(job.fileId);

    for (
        let row = faceSearchRepo.nextPending(job.mediaId);
        row;
        row = faceSearchRepo.nextPending(job.mediaId)
    ) {
        if (!faceSearchRepo.markRunning(row.id)) {
            continue;
        }

        if (!source) {
            faceSearchRepo.fail(row.id, "The file is no longer in the library");
            continue;
        }

        try {
            faceSearchRepo.complete(
                row.id,
                JSON.stringify(await searchFrame(source.absolutePath, row))
            );
        } catch (error) {
            // A cancelled job is stopping, not failing; the next one takes the search back.
            if (signal.aborted) {
                throw error;
            }

            faceSearchRepo.fail(row.id, error instanceof Error ? error.message : String(error));
        }
    }
};
