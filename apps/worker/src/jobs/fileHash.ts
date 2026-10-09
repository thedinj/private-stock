import { z } from "zod";

import { findStage } from "@private-stock/core";
import { db, dupeRepo, mediaFileRepo, mediaRepo } from "@private-stock/db";

import { contentHashFile, quickHashFile } from "../media/fileHash.js";
import { resolveSource } from "../media/sourcePath.js";
import { enqueue, type JobRow } from "../queue.js";

/**
 * The `filehash` job: file identity, and the cheap half of duplicate detection (§5, §10).
 *
 * Exact duplicates are the most common kind in a real library and the easiest to act on —
 * there is nothing to compare, only a choice of which path to keep — but they need a
 * content hash to prove, and hashing every file end to end is not affordable on a NAS.
 *
 * So the job is two-stage. Every file gets a quick hash, which is three seeks whatever its
 * size. Only when that collides does anything get read in full, and then both sides of the
 * collision are hashed properly. A library with no duplicates therefore never reads a whole
 * file, and one with duplicates pays the cost exactly where it buys something.
 *
 * It is also the first thing that happens to a newly scanned file, ahead of the probe (§10f).
 * An identical copy borrows the covers, previews and sprites its twin already has, and the
 * stages that would otherwise render them can only see the twin once this has run.
 */

/** Read from the registry, so the scanner's chain and the sweep share one band (§7d). */
export const FILEHASH_PRIORITY = findStage("filehash")?.priority ?? 40;

/**
 * What the scanner rides on the job: a promise to queue the probe once the file is identified.
 *
 * `probedAt` is what the item's probe timestamp was when the promise was made. A retry of this
 * job finds it different if an earlier attempt already queued a probe that has since run, and
 * queuing a second would re-render every artifact the probe chains — so the promise is kept
 * once. A sweep's hash carries no payload and queues nothing.
 */
const fileHashPayloadSchema = z.object({
    probeAfter: z.literal(true),
    probedAt: z.string().nullable(),
});

export type FileHashPayload = z.infer<typeof fileHashPayloadSchema>;

const PROBE_PRIORITY = 50;

/**
 * Queue the probe the scanner deferred to this job, if it is still owed.
 *
 * Kept whether or not hashing succeeded. A file this job cannot read is still a file the
 * probe should look at, and an item that is never probed has no duration, no dimensions, and
 * no cover — a broken import, over a hash that only ever saved work.
 */
const keepProbePromise = (job: JobRow): void => {
    if (!job.payloadJson || !job.mediaId) {
        return;
    }

    const parsed = fileHashPayloadSchema.safeParse(JSON.parse(job.payloadJson));

    if (!parsed.success) {
        return;
    }

    const probedAt = mediaRepo.findBasic(job.mediaId)?.probedAt ?? null;

    if (probedAt !== parsed.data.probedAt) {
        return;
    }

    enqueue(db, {
        kind: "probe",
        mediaId: job.mediaId,
        fileId: job.fileId,
        priority: PROBE_PRIORITY,
    });
};

export const runFileHash = async (job: JobRow): Promise<void> => {
    if (!job.fileId) {
        throw new Error("filehash job requires a fileId");
    }

    try {
        await hashFile(job.fileId);
    } finally {
        keepProbePromise(job);
    }
};

const hashFile = async (fileId: string): Promise<void> => {
    const source = resolveSource(fileId);

    if (!source) {
        return;
    }

    const quickHash = await quickHashFile(source.absolutePath);

    if (!quickHash) {
        return;
    }

    mediaFileRepo.setHashes(fileId, quickHash, null);

    const peers = mediaFileRepo.quickHashPeers(fileId, quickHash);

    if (peers.length === 0) {
        return;
    }

    /**
     * A collision: read this file in full, and make sure every peer is fully hashed too.
     *
     * Both sides are needed, because a content hash only means anything next to another one.
     * Hashing this file alone would leave the comparison impossible and the collision would
     * be re-discovered, and re-abandoned, on every pass.
     *
     * Only the peers that lack one are read. The first copy of a five-gigabyte file used to be
     * read end to end again for every further copy that arrived, though nothing about it had
     * changed since the last time.
     */
    const contentHash = await contentHashFile(source.absolutePath);

    if (contentHash) {
        mediaFileRepo.setHashes(fileId, null, contentHash);
    }

    for (const peer of peers) {
        if (peer.contentHash) {
            continue;
        }

        const peerSource = resolveSource(peer.id);

        if (!peerSource) {
            continue;
        }

        const peerHash = await contentHashFile(peerSource.absolutePath);

        if (peerHash) {
            mediaFileRepo.setHashes(peer.id, null, peerHash);
        }
    }

    // Only on a genuine collision. Enqueuing a clustering pass after every hashed file would
    // mean one pass per file on a first scan, for a library where nothing has collided.
    dupeRepo.enqueueRescan();
};
