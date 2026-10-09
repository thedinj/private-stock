import { z } from "zod";

import { BULK_ACTION_LIMIT } from "./bulkActions.js";

/**
 * Files the pipeline cannot read, for clearing out (§10g).
 *
 * "Cannot be read" means the probe failed and settled: it used every attempt, or failed in a
 * way that settles at once (`isUnreadableSource`). Such a file has no cover, no duration and no
 * preview -- it cannot be watched, and it still takes its full size on the media volume.
 *
 * Two lists, because reclaiming the space is two steps. Moving a file to the trash copies it to
 * `/data`, so the media volume gets its space back at once and `/data` holds it until the
 * entry is purged; the second list is where that purge is done.
 */

export const UNREADABLE_PAGE_LIMIT = 50;

export const unreadableTabSchema = z.enum(["library", "trash"]);
export type UnreadableTab = z.infer<typeof unreadableTabSchema>;

export const unreadableQuerySchema = z.object({
    tab: unreadableTabSchema.default("library"),
    after: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(UNREADABLE_PAGE_LIMIT).default(UNREADABLE_PAGE_LIMIT),
});
export type UnreadableQuery = z.infer<typeof unreadableQuerySchema>;

export const unreadableItemSchema = z.object({
    mediaId: z.string(),
    title: z.string(),
    rootLabel: z.string(),
    relPath: z.string(),
    bytes: z.number(),
    /** What the probe last said, trimmed to the line that says why. */
    reason: z.string().nullable(),
    /**
     * Whether the reason is one of the container errors that mean the bytes are bad.
     *
     * False for a probe that ran out of attempts some other way -- timeouts, a share that
     * dropped -- where the file may well be fine and is worth reading again before deleting.
     */
    corrupt: z.boolean(),
    failedAt: z.string(),
    /** False on a read-only library, where nothing can be deleted (§18.1). */
    writable: z.boolean(),
    /** Trash tab only: still being copied into the bin, so it cannot be purged yet. */
    moving: z.boolean(),
});
export type UnreadableItem = z.infer<typeof unreadableItemSchema>;

export const unreadableSummarySchema = z.object({
    count: z.number(),
    bytes: z.number(),
});
export type UnreadableSummary = z.infer<typeof unreadableSummarySchema>;

export const unreadablePageSchema = z.object({
    items: z.array(unreadableItemSchema),
    next: z.string().nullable(),
    /** The whole tab, not this page: what acting on everything would involve. */
    summary: unreadableSummarySchema,
});
export type UnreadablePage = z.infer<typeof unreadablePageSchema>;

export const purgeUnreadableSchema = z.object({
    mediaIds: z.array(z.string()).min(1).max(BULK_ACTION_LIMIT),
});
export type PurgeUnreadableInput = z.infer<typeof purgeUnreadableSchema>;
