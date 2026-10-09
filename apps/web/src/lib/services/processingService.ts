import {
    AuthorizationError,
    NotFoundError,
    ValidationError,
    findStage,
    prerequisiteOf,
    prerequisiteSettled,
    stageApplies,
    type StageRow,
} from "@private-stock/core";
import { db, mediaRepo, stageRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { clearProcessingCache } from "./pipelineService";

/**
 * Reading and requesting per-item processing (§7b).
 *
 * The on-demand half of the pipeline: a stage can be run for one item on request, whether or
 * not it is one the sweep runs across the library. That is what makes an expensive capability
 * offerable before it is affordable everywhere.
 */

/** The same visibility rule the library uses — not existing and not being visible look alike. */
const assertVisible = (mediaId: string, auth: AuthContext): void => {
    if (!mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds)) {
        throw new NotFoundError("Media not found");
    }
};

export const listProcessing = (mediaId: string, auth: AuthContext): StageRow[] => {
    assertVisible(mediaId, auth);

    return stageRepo.listForMedia(mediaId);
};

/**
 * Queues a stage for one item.
 *
 * **Admin only.** Processing is expensive and shared: the output goes into the library that
 * everyone sees, and the cost lands on hardware that is already the bottleneck. A viewer
 * being able to queue transcodes or OCR passes across a 200k library is a denial of service
 * with a friendly button.
 */
export const requestProcessing = (mediaId: string, stageName: string, auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can run processing");
    }

    assertVisible(mediaId, auth);

    const stage = findStage(stageName);

    if (!stage) {
        // Named rather than silently ignored: a typo should say so, not appear to work.
        throw new ValidationError(`Unknown processing stage "${stageName}"`);
    }

    const media = mediaRepo.findBasic(mediaId);

    if (!media) {
        throw new NotFoundError("Media not found");
    }

    if (!stageApplies(stage, media.kind)) {
        // Asking for a sprite sheet of a photograph is a mistake worth reporting, not work to
        // queue and then record as skipped.
        throw new ValidationError(`${stage.describe} does not apply to a ${media.kind}`);
    }

    if (stage.needsProbe && !media.probedAt) {
        // Rendered now it would be planned around a guessed duration. The probe is the thing
        // to ask for; the stages that wait on it follow once it succeeds.
        throw new ValidationError("This file has not been read yet. Run the probe first.");
    }

    const prerequisite = prerequisiteOf(stage, media.kind);

    if (
        prerequisite &&
        !prerequisiteSettled(stage, media.kind, stageRepo.find(mediaId, prerequisite.name) ?? null)
    ) {
        // The same reasoning as the probe: there is nothing to read until that stage has run.
        throw new ValidationError(`${prerequisite.describe} has to be made first.`);
    }

    const file = db
        .prepare(
            `SELECT fl."fileId" FROM "MediaFileLink" fl
              WHERE fl."mediaId" = ? AND fl."role" = 'original'`
        )
        .get(mediaId) as { fileId: string } | undefined;

    stageRepo.requestStage(mediaId, stage, file?.fileId ?? null, auth.userId);
    clearProcessingCache();
};
