import {
    AuthorizationError,
    failureReason,
    findStage,
    transcodeEnabled,
    type FailedJob,
    type FailedJobPage,
    type FailedJobQuery,
    type RetryFailedJobs,
    type RetryFailedJobsResult,
} from "@private-stock/core";
import { jobRepo, stageRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { clearProcessingCache } from "./pipelineService";
import { requestProcessing } from "./processingService";
import { loadAdminSettings } from "./settingsService";

/**
 * Failed work, and trying it again (§13c).
 *
 * The Activity tab counted failures for a long time with nothing to act on. A retry goes through
 * the door each kind of work already has rather than re-inserting a copy of the job: a stage
 * through the same request as "Run stage now", which resets the item's attempt counter and
 * checks the stage still applies; a transcode through the same queueing as opening the item.
 * Anything else -- a scan, a deletion's move -- is retried from where it started.
 */

/** A kind-wide retry does this many at most per request. */
const RETRY_BATCH = 500;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can see or retry failed work");
    }
};

type FailedJobRow = jobRepo.FailedJobRow;

const retryable = (row: FailedJobRow): boolean =>
    row.mediaId !== null && (row.kind === "transcode" || findStage(row.kind) !== undefined);

const toFailedJob = (row: FailedJobRow): FailedJob => ({
    id: row.id,
    kind: row.kind,
    mediaId: row.mediaId,
    label: row.title ?? row.relPath,
    lastError: row.lastError,
    reason: failureReason(row.lastError),
    attempts: row.attempts,
    failedAt: row.failedAt,
    retryable: retryable(row),
});

export const listFailedJobs = (query: FailedJobQuery, auth: AuthContext): FailedJobPage => {
    requireAdmin(auth);

    const rows = jobRepo.listFailed({
        kind: query.kind,
        after: query.after ? Number(query.after) : undefined,
        limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);

    return {
        jobs: page.map(toFailedJob),
        next: rows.length > query.limit ? String(page[page.length - 1]!.cursor) : null,
        kinds: jobRepo.failedKinds(),
        unreadable: unreadableInLibrary(auth),
    };
};

/**
 * What Review › Unreadable lists on its library tab, counted by its own rule, so the line here
 * and that page's total agree. The failures on these items are left out of the list above.
 */
const unreadableInLibrary = (auth: AuthContext): { count: number; bytes: number } => {
    const probe = findStage("probe");

    return probe
        ? stageRepo.summarizeSettledFailures(probe, {
              place: "library",
              rootIds: auth.accessibleRootIds,
          })
        : { count: 0, bytes: 0 };
};

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "Could not be queued";

export const retryFailedJobs = (
    input: RetryFailedJobs,
    auth: AuthContext
): RetryFailedJobsResult => {
    requireAdmin(auth);

    const rows =
        "jobIds" in input
            ? jobRepo.findFailed(input.jobIds)
            : jobRepo.listFailed({
                  kind: "kind" in input ? input.kind : undefined,
                  limit: RETRY_BATCH,
              });
    const transcoding = transcodeEnabled(loadAdminSettings().stagePolicy);

    let queued = 0;
    const skipped: RetryFailedJobsResult["skipped"] = [];

    for (const row of rows) {
        if (!retryable(row) || row.mediaId === null) {
            skipped.push({ id: row.id, reason: "Retry this from where it started" });
            continue;
        }

        try {
            if (row.kind === "transcode") {
                if (!transcoding) {
                    skipped.push({ id: row.id, reason: "Transcoding is switched off" });
                    continue;
                }

                jobRepo.enqueueTranscode(row.mediaId);
            } else {
                requestProcessing(row.mediaId, row.kind, auth);
            }

            queued += 1;
        } catch (error) {
            skipped.push({ id: row.id, reason: errorText(error) });
        }
    }

    const standing = (kinds: { kind: string; count: number }[]): number =>
        "kind" in input
            ? (kinds.find((entry) => entry.kind === input.kind)?.count ?? 0)
            : kinds.reduce((sum, entry) => sum + entry.count, 0);
    const remaining = "jobIds" in input ? 0 : standing(jobRepo.failedKinds()) - skipped.length;

    clearProcessingCache();

    return { queued, skipped, remaining: Math.max(0, remaining) };
};
