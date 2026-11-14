import { NotFoundError, type StageState } from "@private-stock/core";
import { libraryFilePath } from "@private-stock/core/server";
import { mediaFileRepo, mediaRepo, mediaRootRepo } from "@private-stock/db";

import { readTiming } from "../media/probe.js";
import type { JobRow } from "../queue.js";

/**
 * The `timing` job: the exact frame rate, variable-rate flag and start timecode of an item
 * probed before they were recorded (§14d "Editor export").
 *
 * Its own stage rather than a probe version bump for the reason `metadata` is: a re-probe
 * chains a cover, a hash and a transcode check behind itself, and this reads one header and
 * chains nothing. New items never reach it -- the probe records it done.
 */
export const runTiming = async (job: JobRow): Promise<StageState> => {
    if (!job.fileId || !job.mediaId) {
        throw new Error("timing job requires both fileId and mediaId");
    }

    const file = mediaFileRepo.findById(job.fileId);

    if (!file) {
        return "empty";
    }

    const root = mediaRootRepo.findById(file.rootId);

    if (!root) {
        throw new NotFoundError(`Root ${file.rootId} no longer exists`);
    }

    const timing = await readTiming(libraryFilePath(root.path, file.relPath));

    mediaRepo.applyTiming(job.mediaId, timing);

    // No rate is a file with no real video stream; there is nothing for an editor here.
    return timing.fpsNum === null ? "empty" : "done";
};
