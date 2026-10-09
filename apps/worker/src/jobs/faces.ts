import * as path from "node:path";

import {
    FACE_TILE_STRIDE,
    assertSafeRelativePath,
    faceFileRelPath,
    findStage,
    type StageOutcome,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { artifactRepo, faceRepo, mediaRepo } from "@private-stock/db";

import { facesInChild } from "../embed/embedder.js";
import { enqueueFaceGroups } from "./faceGroups.js";
import type { FacesSource } from "../embed/protocol.js";
import { placeDataFile, settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";
import { threadsPerJob } from "../throttle.js";

/**
 * The `faces` job: the faces an item shows, kept and recognised (§5f).
 *
 * Reads what the pipeline has already made — every second sprite tile of a video, a photograph's
 * cover — and never the original, as `embed` does. The models run in the shared model child, one
 * family at a time (`embed/embedder.ts`). What the child returns becomes the item's `Face` rows,
 * replacing the last run's and carrying over anything a person decided about them.
 */

/** InsightFace's large set, chosen by the bake-off (§5f). Changing either is a version bump. */
export const FACE_DETECTOR = "face-det-scrfd-10g";
export const FACE_RECOGNISER = "face-rec-arcface-r50";

/** Sprite sheets are a 10×10 grid, padded when a video has fewer than 100 tiles (§9). */
const GRID = 10;

const absolute = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

/** Every second tile of every sheet, counted along the whole video so the stride is even. */
const videoSources = (mediaId: string): FacesSource[] =>
    artifactRepo
        .listForMedia(mediaId, ["sprite"])
        .filter((sheet) => sheet.width && sheet.height && sheet.tileCount && sheet.intervalMs)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((sheet) => {
            const width = sheet.width!;
            const height = sheet.height!;
            const tileWidth = width / GRID;
            const tileHeight = height / GRID;

            return {
                absolutePath: absolute(sheet.relPath),
                width,
                height,
                regions: Array.from({ length: sheet.tileCount! }, (_, index) => index)
                    .filter(
                        (index) => (sheet.ordinal * GRID * GRID + index) % FACE_TILE_STRIDE === 0
                    )
                    .map((index) => ({
                        rect: {
                            x: (index % GRID) * tileWidth,
                            y: Math.floor(index / GRID) * tileHeight,
                            width: tileWidth,
                            height: tileHeight,
                        },
                        atMs: (sheet.ordinal * GRID * GRID + index) * sheet.intervalMs!,
                    })),
            };
        })
        .filter((source) => source.regions.length > 0);

/** A photograph is one region: its generated cover, the whole of it. */
const imageSources = (mediaId: string): FacesSource[] => {
    const cover = artifactRepo.findOne(mediaId, "cover", 0);

    if (!cover?.width || !cover.height) {
        return [];
    }

    return [
        {
            absolutePath: absolute(cover.relPath),
            width: cover.width,
            height: cover.height,
            regions: [
                { rect: { x: 0, y: 0, width: cover.width, height: cover.height }, atMs: null },
            ],
        },
    ];
};

export const runFaces = async (job: JobRow): Promise<StageOutcome | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("faces job requires both mediaId and fileId");
    }

    const media = mediaRepo.findBasic(job.mediaId);

    if (!media) {
        return "skipped";
    }

    /**
     * An identical copy shows the same faces (§10f): its file borrowed by hardlink, its rows and
     * what people said about them copied. The child writes by rename, so a later run on either
     * cannot rewrite the other through the link.
     */
    const twin = settledTwin(job.fileId, "faces");

    if (twin?.state === "empty") {
        faceRepo.replaceForMedia(job.mediaId, []);

        return "empty";
    }

    if (twin) {
        try {
            await placeDataFile(faceFileRelPath(twin.mediaId), faceFileRelPath(job.mediaId), {
                hardlink: true,
            });

            if (faceRepo.copyFromTwin(twin.mediaId, job.mediaId) > 0) {
                enqueueFaceGroups();

                return "done";
            }
        } catch {
            // The twin's file is gone or unreadable: read this one's own pictures.
        }
    }

    const sources = media.kind === "video" ? videoSources(job.mediaId) : imageSources(job.mediaId);

    if (sources.length === 0) {
        // The prerequisite settled with nothing to read: a video too short for sprites, a cover
        // that could not be drawn. Nothing to look at, and nothing a retry would find.
        faceRepo.replaceForMedia(job.mediaId, []);

        return "empty";
    }

    const result = await facesInChild({
        detector: FACE_DETECTOR,
        recogniser: FACE_RECOGNISER,
        stageVersion: findStage("faces")!.version,
        threads: threadsPerJob(),
        sources,
        outPath: absolute(faceFileRelPath(job.mediaId)),
    });

    faceRepo.replaceForMedia(job.mediaId, result.faces);

    if (result.faces.length === 0) {
        return "empty";
    }

    // New faces, so the library's groups are out of date; one run after the burst settles.
    enqueueFaceGroups();
};
