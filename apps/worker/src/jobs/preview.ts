import { stat } from "node:fs/promises";
import * as path from "node:path";

import { type StageState, artifactRelPath } from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { artifactRepo, db, mediaRepo } from "@private-stock/db";

import { renderPreview } from "../media/clips.js";
import { imageDimensions } from "../media/frames.js";
import { resolveSource } from "../media/sourcePath.js";
import { adoptArtifacts, settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";

/**
 * The `preview` job: the clip that plays on hover and in gallery mode (§9).
 *
 * Videos only, and the artifact is optional by design — a file too short to sample simply
 * has no preview, and the grid falls back to its cover. A missing preview is a tile that
 * does not animate, not a broken one.
 */

export const PREVIEW_GENERATOR_VERSION = 1;

export const runPreview = async (job: JobRow): Promise<StageState | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("preview job requires both mediaId and fileId");
    }

    const mediaId = job.mediaId;
    const media = mediaRepo.findBasic(mediaId);

    if (!media || media.kind !== "video") {
        // Stills have nothing to loop. Not applicable rather than not done, so the sweep
        // stops offering it.
        return "skipped";
    }

    const source = resolveSource(job.fileId);

    if (!source) {
        return "skipped";
    }

    // An identical copy already has one, or already found it could not have one (§10f).
    const twin = settledTwin(job.fileId, "preview");

    if (twin?.state === "empty") {
        return "empty";
    }

    if (twin && (await adoptArtifacts(mediaId, twin.mediaId, (row) => row.kind === "preview"))) {
        artifactRepo.recordArtifactChange(mediaId, source.rootId, "preview");
        return;
    }

    const config = loadConfig();
    const relPath = artifactRelPath(mediaId, "preview");
    const outputPath = path.resolve(config.dataDir, relPath);

    const rendered = await renderPreview(source.absolutePath, outputPath, media.durationMs);

    if (!rendered) {
        // Too short to sample, or nothing decodable. A file that cannot have a preview is a
        // settled answer, not a gap to retry every five minutes (§7b).
        return "empty";
    }

    const [{ width, height }, stats] = await Promise.all([
        imageDimensions(outputPath),
        stat(outputPath),
    ]);

    db.transaction(() => {
        artifactRepo.upsert({
            mediaId,
            kind: "preview",
            ordinal: 0,
            relPath,
            width,
            height,
            bytes: stats.size,
            source: "auto",
            generatorVersion: PREVIEW_GENERATOR_VERSION,
        });

        artifactRepo.recordArtifactChange(mediaId, source.rootId, "preview");
    })();
};
