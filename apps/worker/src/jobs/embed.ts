import { appendFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import {
    REPRESENTATIVES_LOG_REL_PATH,
    assertSafeRelativePath,
    decodeVectorFile,
    encodeRepresentatives,
    findStage,
    vectorFileRelPath,
    type StageOutcome,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { artifactRepo, mediaRepo } from "@private-stock/db";

import { embedInChild } from "../embed/embedder.js";
import type { EmbedSource } from "../embed/protocol.js";
import { placeDataFile, settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";
import { threadsPerJob } from "../throttle.js";

/**
 * The `embed` job: what each moment of an item looks like, as vectors (§5e).
 *
 * Reads what the pipeline has already made — the sprite sheets of a video, the cover of a
 * photograph — and never the original, which on these disks is the difference between a stage
 * that can run overnight and one that competes with playback. The model runs in a child process
 * (`embed/embedder.ts`) so its memory goes back when the work stops.
 *
 * Two outputs: the item's vectors file, and its representatives appended to the log the web
 * process loads in one read. The log is written only here, and `embed` runs one job at a time,
 * so it has a single writer.
 */

/** The model this stage's version embeds with. Changing it is a version bump (§7b). */
export const EMBED_MODEL = "clip-b32-vision-uint8";

/** Sprite sheets are a 10×10 grid, padded when a video has fewer than 100 tiles (§9). */
const GRID = 10;

const absolute = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

/** The moments of a video: every tile of every sheet, at the time each was sampled. */
const videoSources = (mediaId: string): EmbedSource[] =>
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
                moments: Array.from({ length: sheet.tileCount! }, (_, index) => ({
                    rect: {
                        x: (index % GRID) * tileWidth,
                        y: Math.floor(index / GRID) * tileHeight,
                        width: tileWidth,
                        height: tileHeight,
                    },
                    atMs: (sheet.ordinal * GRID * GRID + index) * sheet.intervalMs!,
                })),
            };
        });

/** A photograph is one moment: its generated cover, the whole of it. */
const imageSources = (mediaId: string): EmbedSource[] => {
    const cover = artifactRepo.findOne(mediaId, "cover", 0);

    if (!cover?.width || !cover.height) {
        return [];
    }

    return [
        {
            absolutePath: absolute(cover.relPath),
            width: cover.width,
            height: cover.height,
            moments: [
                { rect: { x: 0, y: 0, width: cover.width, height: cover.height }, atMs: null },
            ],
        },
    ];
};

/** Add the item's representatives to the log, read back from its vectors file. */
const appendRepresentatives = async (mediaId: string): Promise<void> => {
    const file = decodeVectorFile(
        new Uint8Array(await readFile(absolute(vectorFileRelPath(mediaId))))
    );
    const log = absolute(REPRESENTATIVES_LOG_REL_PATH);

    await mkdir(path.dirname(log), { recursive: true });
    await appendFile(log, encodeRepresentatives(mediaId, file));
};

export const runEmbed = async (job: JobRow): Promise<StageOutcome | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("embed job requires both mediaId and fileId");
    }

    const media = mediaRepo.findBasic(job.mediaId);

    if (!media) {
        return "skipped";
    }

    /**
     * An identical copy has identical sprites, so its vectors are this item's vectors (§10f).
     * Hardlinked: the child writes by rename, so a later re-embed of either cannot rewrite the
     * other through the link.
     */
    const twin = settledTwin(job.fileId, "embed");

    if (twin?.state === "empty") {
        return "empty";
    }

    if (twin) {
        try {
            await placeDataFile(vectorFileRelPath(twin.mediaId), vectorFileRelPath(job.mediaId), {
                hardlink: true,
            });
            await appendRepresentatives(job.mediaId);

            return "done";
        } catch {
            // The twin's file is gone or unreadable: embed this one from its own sheets.
        }
    }

    const sources = media.kind === "video" ? videoSources(job.mediaId) : imageSources(job.mediaId);

    if (sources.length === 0) {
        // The prerequisite settled with nothing to read: a video too short for sprites, a cover
        // that could not be drawn. Nothing to embed, and nothing a retry would find.
        return "empty";
    }

    const result = await embedInChild({
        model: EMBED_MODEL,
        stageVersion: findStage("embed")!.version,
        threads: threadsPerJob(),
        sources,
        outPath: absolute(vectorFileRelPath(job.mediaId)),
    });

    if (result.vectors === 0) {
        return "empty";
    }

    await appendRepresentatives(job.mediaId);
};
