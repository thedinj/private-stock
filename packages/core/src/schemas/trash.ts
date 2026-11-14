import { z } from "zod";

/**
 * The recycle bin contract (§10).
 *
 * Deleting is two decisions separated by a retention window: trashing hides an item and leaves
 * its file where it is, and purging -- which unlinks the file there -- is the irreversible one. The response carries
 * enough to review a deletion without opening the item, because by then the item is not in
 * the library to open.
 */

export const trashEntrySchema = z.object({
    id: z.string(),
    /**
     * Null once the item has been purged.
     *
     * The entry outlives the item deliberately: an audit trail that disappears with the thing
     * it describes records nothing about the only event worth recording.
     */
    mediaId: z.string().nullable(),
    title: z.string().nullable(),
    kind: z.enum(["image", "video"]).nullable(),
    rootLabel: z.string(),
    relPath: z.string(),
    bytes: z.number(),
    deletedBy: z.string(),
    deletedAt: z.string(),
    purgeAfter: z.string(),
    /** The cover, kept until purge — a trash view without one can only be guessed at. */
    coverUrl: z.string().nullable(),
});
export type TrashEntry = z.infer<typeof trashEntrySchema>;

export const trashListResponseSchema = z.object({
    entries: z.array(trashEntrySchema),
    /** Every open entry, not only this page's -- what emptying the bin would purge. */
    total: z.number(),
    /**
     * Bytes held in the bin, which is the number that decides whether to purge early. They are
     * still in the libraries, at their own paths, until purged.
     */
    heldBytes: z.number(),
});
export type TrashListResponse = z.infer<typeof trashListResponseSchema>;

/** What emptying the bin started (§10). */
export const emptyTrashResponseSchema = z.object({
    /** Entries whose purge is queued. */
    queued: z.number(),
    /** Bytes the purges will give back to the libraries' volume once they run. */
    freedBytes: z.number(),
});
export type EmptyTrashResponse = z.infer<typeof emptyTrashResponseSchema>;

/**
 * How long an item stays recoverable.
 *
 * Seven days by default rather than the thirty a desktop recycle bin uses, because a trashed
 * file keeps its space until it is purged: a retention window on a NAS is a disk commitment,
 * not just a grace period.
 */
export const DEFAULT_TRASH_RETENTION_DAYS = 7;

export const trashSettingsSchema = z.object({
    /**
     * Zero means purge on the next sweep.
     *
     * Allowed, because someone reclaiming space should not have to wait a day for a setting
     * to take effect, and the alternative is an admin deleting rows by hand. The UI is
     * responsible for making the consequence obvious.
     */
    retentionDays: z.number().int().min(0).max(365),
});
export type TrashSettings = z.infer<typeof trashSettingsSchema>;

export const DEFAULT_TRASH_SETTINGS: TrashSettings = {
    retentionDays: DEFAULT_TRASH_RETENTION_DAYS,
};
