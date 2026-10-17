import { phashFromLuma, type StageState } from "@private-stock/core";
import { mediaRepo, phashRepo } from "@private-stock/db";

import { lumaFromImage, lumaFromVideo, sampleOffsets } from "../media/luma.js";
import { resolveSource } from "../media/sourcePath.js";
import { settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";

import { queueDupePass } from "./dupes.js";

/**
 * The `phash` job: the perceptual fingerprint of one item (§10).
 *
 * An image gets one hash; a video gets one per sampled keyframe, because a video's identity
 * is not any single frame — a re-encode, a rescale, and a clip cut from a longer file all
 * need to match, and only a set of frames can express that.
 *
 * Flat frames are skipped rather than stored. Fades to black and letterbox bars carry no
 * signal, and their hashes are floating-point noise, so keeping them would cluster every
 * video in the library with every other through frames that mean nothing.
 */

const hashImage = async (mediaId: string, absolutePath: string): Promise<boolean> => {
    const luma = await lumaFromImage(absolutePath);

    if (!luma) {
        return false;
    }

    const { hash, flat } = phashFromLuma(luma);

    if (flat) {
        // A blank image is a legitimate file, just not a fingerprintable one. Recording no
        // hash is the correct outcome, not a failure.
        return false;
    }

    phashRepo.putImageHash(mediaId, hash);

    return true;
};

const hashVideo = async (
    mediaId: string,
    absolutePath: string,
    durationMs: number | null
): Promise<boolean> => {
    const offsets = sampleOffsets(durationMs);
    const frames: { frameIdx: number; atMs: number; hash: Uint8Array }[] = [];

    for (const [index, atMs] of offsets.entries()) {
        const luma = await lumaFromVideo(absolutePath, atMs);

        if (!luma) {
            continue;
        }

        const { hash, flat } = phashFromLuma(luma);

        if (!flat) {
            // `frameIdx` is the position in the sample plan, not the count of frames kept —
            // so a skipped fade does not renumber the frames after it, and two runs of the
            // same file describe the same moments.
            frames.push({ frameIdx: index, atMs, hash });
        }
    }

    if (frames.length === 0) {
        return false;
    }

    phashRepo.putVideoHashes(mediaId, frames);

    return true;
};

/**
 * Copy the fingerprint of an identical copy rather than decoding frames for it (§10f).
 *
 * Identical bytes hash identically, so this is the same answer for none of the work. It still
 * reaches clustering like any other hash, which is where the two are put in a group together.
 */
const borrowHashes = (mediaId: string, twinMediaId: string, kind: "image" | "video"): boolean => {
    if (kind === "image") {
        const hash = phashRepo.findImageHash(twinMediaId);

        if (!hash) {
            return false;
        }

        phashRepo.putImageHash(mediaId, hash);

        return true;
    }

    const frames = phashRepo.listVideoHashes(twinMediaId);

    if (frames.length === 0) {
        return false;
    }

    phashRepo.putVideoHashes(
        mediaId,
        frames.map(({ frameIdx, atMs, hash }) => ({ frameIdx, atMs, hash }))
    );

    return true;
};

export const runPhash = async (job: JobRow): Promise<StageState | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("phash job requires both mediaId and fileId");
    }

    const media = mediaRepo.findBasic(job.mediaId);
    const source = resolveSource(job.fileId);

    if (!media || !source) {
        // The item or its file went away between queueing and running. Nothing to record
        // against; the next scan reconciles it.
        return "skipped";
    }

    const twin = settledTwin(job.fileId, "phash");

    if (twin?.state === "empty") {
        return "empty";
    }

    const hashed =
        (twin !== null && borrowHashes(job.mediaId, twin.mediaId, media.kind)) ||
        (media.kind === "image"
            ? await hashImage(job.mediaId, source.absolutePath)
            : await hashVideo(job.mediaId, source.absolutePath, media.durationMs));

    if (!hashed) {
        /**
         * Ran correctly and produced nothing: a blank image, a video of nothing but fades,
         * or a file the decoder could not read a usable frame from.
         *
         * Saying so is the whole point of the stage table. Under the previous scheme this
         * was indistinguishable from never having run, and the sweep re-queued the item
         * every five minutes for the life of the library (§7b).
         */
        return "empty";
    }

    /**
     * Clustering is a separate job rather than inline work.
     *
     * Hashing is per-file and parallel; clustering reads other items' hashes and writes
     * shared groups, so running it inside the hash job would have several workers building
     * overlapping groups from half-written data. One coalescing job, at low priority, does
     * it once after the hashes have settled.
     */
    queueDupePass();
};
