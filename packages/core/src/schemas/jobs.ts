import { z } from "zod";

/**
 * Failed work, for the Activity tab (§13c).
 *
 * **Only failures that still stand.** A failed `Job` row is kept after the work succeeds on a
 * later attempt -- `settledMediaIds` needs it (§20) -- so "every failed row" counts problems that
 * were fixed weeks ago. A failure stands while no later job exists for the same kind and item.
 */
export const failedJobSchema = z.object({
    id: z.string(),
    kind: z.string(),
    mediaId: z.string().nullable(),
    /** The item's title, or its file's path where it has none; null for library-wide work. */
    label: z.string().nullable(),
    lastError: z.string().nullable(),
    /** The line of `lastError` that says why (`failureReason`), for a row with room for one. */
    reason: z.string().nullable(),
    attempts: z.number(),
    failedAt: z.string(),
    /**
     * Whether Retry can be offered here. A stage on an item goes through the same request as
     * "Run stage now" on its page, and a transcode through the same queueing as playing it;
     * anything else (a scan, a deletion's move) is retried from where it started.
     */
    retryable: z.boolean(),
});
export type FailedJob = z.infer<typeof failedJobSchema>;

export const failedJobPageSchema = z.object({
    jobs: z.array(failedJobSchema),
    /** Cursor for the next page, or null at the end. */
    next: z.string().nullable(),
    /** Standing failures per kind, most first, for the kind filter. */
    kinds: z.array(z.object({ kind: z.string(), count: z.number() })),
    /**
     * Files in the library the probe has settled as unreadable (§10g), with what they hold.
     * Their failures are left out of this list -- every stage fails on them, and no retry will
     * help -- so the tab says how many there are and links to the review that can clear them.
     */
    unreadable: z.object({ count: z.number(), bytes: z.number() }),
});
export type FailedJobPage = z.infer<typeof failedJobPageSchema>;

export const failedJobQuerySchema = z.object({
    kind: z.string().trim().min(1).max(40).optional(),
    after: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type FailedJobQuery = z.infer<typeof failedJobQuerySchema>;

/** Retry these failures, every standing failure of one kind, or every one listed. */
export const retryFailedJobsSchema = z.union([
    z.object({ jobIds: z.array(z.string().min(1).max(64)).min(1).max(500) }),
    z.object({ kind: z.string().trim().min(1).max(40) }),
    z.object({ all: z.literal(true) }),
]);
export type RetryFailedJobs = z.infer<typeof retryFailedJobsSchema>;

export const retryFailedJobsResultSchema = z.object({
    queued: z.number(),
    /** Failures that could not be retried here, and why. */
    skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
    /** Standing failures left over, of that kind or of any, when a wide retry hit its batch limit. */
    remaining: z.number(),
});
export type RetryFailedJobsResult = z.infer<typeof retryFailedJobsResultSchema>;

/**
 * The transcode queue (§8), for the Transcoding tab. No done or failed counts: finished jobs are
 * pruned, and failures are the Activity tab's list, which counts only the ones still standing.
 */
export const transcodeQueueSchema = z.object({
    pending: z.number(),
    running: z.number(),
    inFlight: z.array(z.object({ mediaId: z.string().nullable(), progress: z.number() })),
});
export type TranscodeQueue = z.infer<typeof transcodeQueueSchema>;

/** What "Queue unplayable files" did: how many it queued, of how many it looked at. */
export const transcodeRequeueResultSchema = z.object({
    queued: z.number(),
    examined: z.number(),
});
export type TranscodeRequeueResult = z.infer<typeof transcodeRequeueResultSchema>;
