import { NotFoundError, type StageState } from "@private-stock/core";
import { libraryFilePath } from "@private-stock/core/server";
import { mediaAttributeRepo, mediaFileRepo, mediaRootRepo, searchRepo } from "@private-stock/db";

import { readEmbeddedText } from "../media/probe.js";
import type { JobRow } from "../queue.js";

/**
 * The `metadata` job: keep the descriptive tags a file carries about itself (§5b).
 *
 * Its own stage rather than part of the probe, because the probe cannot be re-run across a
 * library: it chains a cover, a hash and a transcode check behind itself every time, which is
 * how a changed file gets new ones. This one chains only the search document -- which is also
 * where the names the tags mention are matched (§5b "One rule for names") -- so a version bump
 * here is a cheap sweep.
 */
export const runMetadata = async (job: JobRow): Promise<StageState> => {
    if (!job.fileId || !job.mediaId) {
        throw new Error("metadata job requires both fileId and mediaId");
    }

    const file = mediaFileRepo.findById(job.fileId);

    if (!file) {
        return "empty";
    }

    const root = mediaRootRepo.findById(file.rootId);

    if (!root) {
        throw new NotFoundError(`Root ${file.rootId} no longer exists`);
    }

    const found = await readEmbeddedText(libraryFilePath(root.path, file.relPath));

    if (mediaAttributeRepo.replaceEmbedded(job.mediaId, found)) {
        searchRepo.requestReindex([job.mediaId]);
    }

    return found.size > 0 ? "done" : "empty";
};
