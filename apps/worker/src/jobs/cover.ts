import { rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import { artifactRelPath } from "@private-stock/core";
import { dataPaths, loadConfig } from "@private-stock/core/server";
import { artifactRepo, db, mediaRepo } from "@private-stock/db";

import {
    NEAR_BLACK_LUMINANCE,
    averageLuminance,
    extractFrame,
    imageDimensions,
} from "../media/frames.js";
import { resolveSource } from "../media/sourcePath.js";
import { adoptArtifacts, settledTwin } from "../media/twin.js";
import { enqueue, type JobRow } from "../queue.js";

/**
 * The `cover` job: give every item a picture (§9).
 *
 * A video gets five frames — one becomes the cover, the other four become alternates a
 * person can switch to without waiting for anything to be regenerated. That is the cheap
 * half of "let users override the thumbnail": the alternatives already exist by the time
 * anyone wants one.
 *
 * An image gets one downscaled copy. Serving a 12 MP original into a 190px grid tile is the
 * difference between a library that scrolls and one that does not.
 */

/**
 * Bumping this invalidates existing auto artifacts.
 *
 * `Artifact.generatorVersion` is stored per row so a changed recipe can re-enqueue only the
 * stale ones, rather than either regenerating a whole library or leaving it inconsistent
 * forever.
 */
export const COVER_GENERATOR_VERSION = 1;

/** Wide enough for a retina grid tile and for the detail page's header. */
const COVER_WIDTH = 640;

/**
 * Where the candidates are sampled from, as fractions of the duration.
 *
 * The first is the cover unless it is a black frame. Ten percent rather than the start
 * because openings are logos, fades and title cards; not later, because a cover taken from
 * the middle of a film is a spoiler and a cover taken from the end is the credits.
 */
const CANDIDATE_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

/**
 * Offsets used when the duration is unknown.
 *
 * An unprobed or malformed file still deserves a cover attempt. Seeking past the end simply
 * produces no frame, which is handled as a failed candidate rather than a failed job.
 */
const FALLBACK_OFFSETS_MS = [3_000, 10_000, 30_000, 60_000, 120_000];

interface Candidate {
    atMs: number;
    tempPath: string;
    luminance: number;
}

export const candidateOffsets = (durationMs: number | null): number[] => {
    if (!durationMs || durationMs <= 0) {
        return FALLBACK_OFFSETS_MS;
    }

    // A very short clip has no meaningful 90% mark distinct from its end; clamp inside the
    // last second so ffmpeg has a frame to find.
    const usable = Math.max(0, durationMs - 1_000);

    return CANDIDATE_FRACTIONS.map((fraction) => Math.floor(usable * fraction));
};

export const runCover = async (job: JobRow): Promise<void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("cover job requires both mediaId and fileId");
    }

    const mediaId = job.mediaId;
    const media = mediaRepo.findBasic(mediaId);

    if (!media) {
        // Removed between the scan and now. Not an error worth retrying.
        return;
    }

    const source = resolveSource(job.fileId);

    if (!source) {
        return;
    }

    const config = loadConfig();
    const artDir = path.resolve(config.dataDir, path.dirname(artifactRelPath(mediaId, "cover")));
    const absolute = (relPath: string): string => path.resolve(config.dataDir, relPath);

    // Sanity: everything this job writes must land under dataDir/art, never near a media
    // root. The app's only write to a media root is a delete (§18.1).
    const artRoot = dataPaths(config).art;
    if (!artDir.startsWith(artRoot + path.sep) && artDir !== artRoot) {
        throw new Error(`Refusing to write artifacts outside ${artRoot}`);
    }

    const borrowed = await borrowCovers(mediaId, job.fileId, source.rootId);

    if (media.kind === "image") {
        if (!borrowed) {
            await generateImageCover(mediaId, source.absolutePath, absolute, source.rootId);
        }

        return;
    }

    if (!borrowed) {
        await generateVideoCovers(
            mediaId,
            source.absolutePath,
            media.durationMs,
            artDir,
            absolute,
            source.rootId
        );
    }

    /**
     * The expensive artifacts are queued only once a cover exists.
     *
     * Ordering matters on a first scan of a large library. Sprites and previews both cost far
     * more than a cover — sprites decode the entire file — so running them first would mean
     * an hour of work before a single tile had a picture. Lower priority puts every pending
     * cover ahead of them too, not just this item's.
     */
    enqueue(db, { kind: "preview", mediaId, fileId: job.fileId, priority: 120 });
    enqueue(db, { kind: "sprite", mediaId, fileId: job.fileId, priority: 140 });
};

/**
 * Take the cover and alternates an identical copy already has, rather than extracting them (§10f).
 *
 * The generated cover and its posters only. A twin's chosen cover and the renderings of its
 * captures are about that item; this one starts from the generator's choice, as it would have
 * had it rendered its own.
 */
const borrowCovers = async (mediaId: string, fileId: string, rootId: string): Promise<boolean> => {
    const twin = settledTwin(fileId, "cover");

    if (!twin) {
        return false;
    }

    const borrowed = await adoptArtifacts(
        mediaId,
        twin.mediaId,
        (row) => (row.kind === "cover" && row.ordinal === 0) || row.kind === "poster"
    );

    if (!borrowed) {
        return false;
    }

    artifactRepo.recordArtifactChange(mediaId, rootId, "cover");

    return true;
};

/**
 * A still image is its own cover: one downscaled copy, no candidates to choose between.
 *
 * An animated GIF takes its first frame rather than a representative one, so the cover
 * matches what the grid shows before the animation starts.
 */
const generateImageCover = async (
    mediaId: string,
    sourcePath: string,
    absolute: (relPath: string) => string,
    rootId: string
): Promise<void> => {
    const relPath = artifactRelPath(mediaId, "cover");
    const outputPath = absolute(relPath);

    await extractFrame(sourcePath, outputPath, { width: COVER_WIDTH });

    const [{ width, height }, stats] = await Promise.all([
        imageDimensions(outputPath),
        stat(outputPath),
    ]);

    db.transaction(() => {
        artifactRepo.upsert({
            mediaId,
            kind: "cover",
            ordinal: 0,
            relPath,
            width,
            height,
            bytes: stats.size,
            source: "auto",
            generatorVersion: COVER_GENERATOR_VERSION,
        });

        artifactRepo.recordArtifactChange(mediaId, rootId, "cover");
    })();
};

/**
 * Extract five candidates, promote one to the cover, keep the rest as alternates.
 *
 * The candidates are written to temporary names and renamed into place at the end. Two
 * reasons: which one becomes the cover is not known until all of them have been measured,
 * and a job that dies halfway leaves no half-written `cover.webp` for the grid to serve.
 */
const generateVideoCovers = async (
    mediaId: string,
    sourcePath: string,
    durationMs: number | null,
    artDir: string,
    absolute: (relPath: string) => string,
    rootId: string
): Promise<void> => {
    const offsets = candidateOffsets(durationMs);
    const candidates: Candidate[] = [];

    const attempt = async (atMs: number, index: number): Promise<void> => {
        const tempPath = path.join(artDir, `.candidate-${index}.webp`);

        try {
            await extractFrame(sourcePath, tempPath, {
                atMs,
                width: COVER_WIDTH,
                representative: true,
            });

            candidates.push({ atMs, tempPath, luminance: await averageLuminance(tempPath) });
        } catch {
            // One unreachable offset — past the end of a file whose duration was wrong, or a
            // corrupt region — must not cost the other four.
            await rm(tempPath, { force: true });
        }
    };

    for (const [index, atMs] of offsets.entries()) {
        await attempt(atMs, index);
    }

    /**
     * Last resort: the very first frame.
     *
     * Every sampled offset is some way into the file, deliberately — a cover taken from the
     * first moments is a logo or a fade (see CANDIDATE_FRACTIONS). But a file can hold fewer
     * frames than the offsets assume, and then every probe seeks past the only one there is.
     *
     * Five real examples: `.mov` files reporting `mjpeg`, 1/3 fps and a three-minute
     * duration, whose video stream contains exactly one frame — `nb_frames=1`. `-ss 0`
     * produces a cover from them; `-ss 3.0` already finds nothing. They failed cover
     * generation three times each and stayed coverless.
     *
     * Kept out of CANDIDATE_FRACTIONS rather than added as a sixth: a file that has frames
     * where we expect them should still never be represented by its title card. This runs
     * only when the alternative is no cover at all.
     */
    if (candidates.length === 0) {
        await attempt(0, offsets.length);
    }

    if (candidates.length === 0) {
        throw new Error("ffmpeg produced no frames for this file");
    }

    // The earliest candidate that is not a black frame or a fade. If every frame is dark the
    // video genuinely is dark, and the first one is still the right answer — better a dark
    // cover than none.
    const coverIndex = Math.max(
        0,
        candidates.findIndex((candidate) => candidate.luminance >= NEAR_BLACK_LUMINANCE)
    );

    const cover = candidates[coverIndex];
    const alternates = candidates.filter((_, index) => index !== coverIndex);

    const written: {
        kind: "cover" | "poster";
        ordinal: number;
        relPath: string;
        atMs: number;
        bytes: number;
    }[] = [];

    const place = async (
        candidate: Candidate,
        kind: "cover" | "poster",
        ordinal: number
    ): Promise<void> => {
        const relPath = artifactRelPath(mediaId, kind, ordinal);
        const target = absolute(relPath);

        await rename(candidate.tempPath, target);

        written.push({
            kind,
            ordinal,
            relPath,
            atMs: candidate.atMs,
            bytes: (await stat(target)).size,
        });
    };

    await place(cover, "cover", 0);

    // Posters are numbered from 1, leaving 0 to the cover so the two never collide in the
    // directory listing or in the URL space.
    for (const [index, candidate] of alternates.entries()) {
        await place(candidate, "poster", index + 1);
    }

    // All five frames come from the same filter chain, so they share dimensions; measuring
    // one is measuring all of them.
    const { width, height } = await imageDimensions(absolute(written[0].relPath));

    db.transaction(() => {
        for (const artifact of written) {
            artifactRepo.upsert({
                mediaId,
                kind: artifact.kind,
                ordinal: artifact.ordinal,
                relPath: artifact.relPath,
                width,
                height,
                bytes: artifact.bytes,
                atMs: artifact.atMs,
                source: "auto",
                generatorVersion: COVER_GENERATOR_VERSION,
            });
        }

        artifactRepo.recordArtifactChange(mediaId, rootId, "cover");
    })();
};
