import { z } from "zod";

import { tagIdListSchema } from "./tags.js";
import { captureSchema } from "./captures.js";
import { clipSchema } from "./clips.js";
import { mediaListItemSchema, mediaQuerySchema, type MediaSort } from "./media.js";
import { reelEntrySchema } from "./reels.js";

/**
 * The library's tabs beyond Videos and Photos (§14e "What a kind is"): your clips, your
 * captures, and All -- which, since 2026-11-08, means all four.
 *
 * Videos and Photos stay on `/api/media` and `MediaQuery` exactly as they were; these three are
 * `/api/library`, whose query is the library's own with a wider kind. `MediaQuery.kind` is not
 * widened: it reaches every list, shelf and saved view, and `Media.kind`'s CHECK beside it.
 */
export const libraryTabs = ["clip", "capture", "all"] as const;
export const libraryTabSchema = z.enum(libraryTabs);
export type LibraryTab = z.infer<typeof libraryTabSchema>;

/**
 * The orders every kind can answer, and so the only ones these tabs offer.
 *
 * A clip has a name, a date, a run time and stars; a capture has a name and a date. Size,
 * resolution, bitrate and the rest describe a file, and a merged list sorted by one of them would
 * have nowhere honest to put a clip. A query asking for another is run by date added.
 */
export const LIBRARY_SORTS: readonly MediaSort[] = [
    "addedAt",
    "title",
    "duration",
    "rating",
    "random",
    "relevance",
];

export const librarySort = (sort: MediaSort): MediaSort =>
    LIBRARY_SORTS.includes(sort) ? sort : "addedAt";

export const libraryQuerySchema = mediaQuerySchema.omit({ kind: true }).extend({
    kind: libraryTabSchema,
    /**
     * Tag ids whose pick, for a clip, also accepts its video carrying the tag ("or its video",
     * §14d "Tagging clips"). Each must also be in `tags` or `notTags`.
     */
    orVideo: tagIdListSchema.optional(),
    /** Clips not in any reel yet. Nothing else can be in a reel, so nothing else matches. */
    unusedOnly: z.coerce.boolean().optional(),
});
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;

export const libraryEntrySchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("media"), item: mediaListItemSchema }),
    z.object({ type: z.literal("clip"), clip: clipSchema }),
    z.object({ type: z.literal("capture"), capture: captureSchema }),
]);
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export type LibraryEntryType = LibraryEntry["type"];

/** The id an entry is selected and keyed by, which is its own row's. */
export const libraryEntryId = (entry: LibraryEntry): string =>
    entry.type === "media"
        ? entry.item.id
        : entry.type === "clip"
          ? entry.clip.id
          : entry.capture.artifactId;

export const libraryListResponseSchema = z.object({
    items: z.array(libraryEntrySchema),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
});
export type LibraryListResponse = z.infer<typeof libraryListResponseSchema>;

export const libraryCountResponseSchema = z.object({
    total: z.number(),
    pageCount: z.number(),
    /** How many of each kind, so a tab's count and All's agree. */
    byType: z.object({ media: z.number(), clip: z.number(), capture: z.number() }),
});
export type LibraryCountResponse = z.infer<typeof libraryCountResponseSchema>;

/**
 * The Clips tab played from the top (§14e "Playing the small kinds"): its clips in the tab's
 * order, as the reel player takes them -- an unsaved reel. Not paged, for a reel's reason: a
 * player must not ask a second question part way through. `REEL_ITEM_LIMIT` bounds it, and
 * `more` says the tab holds more than that.
 */
export const libraryClipRunSchema = z.object({
    items: z.array(reelEntrySchema),
    runningMs: z.number(),
    more: z.boolean(),
});
export type LibraryClipRun = z.infer<typeof libraryClipRunSchema>;
