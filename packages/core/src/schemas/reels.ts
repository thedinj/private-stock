import { z } from "zod";

import { REEL_ITEM_LIMIT } from "../clips.js";
import { collectionVisibilitySchema, sortDirectionSchema, type SortDirection } from "../domain.js";
import { clipSchema } from "./clips.js";

/**
 * Reel contracts (§14d).
 *
 * A reel is an ordered arrangement of spans, shared by the same gesture as a playlist or a saved
 * view and holding **nothing but its owner's clips**. That invariant is what answers most of
 * what would otherwise be hard here: a retime can name every reel it will reach, a discard
 * cannot shorten a stranger's work, and an entry needs no author because they all belong to the
 * person already named on the reel.
 */

export const createReelSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullish(),
    visibility: collectionVisibilitySchema.default("private"),
    /** Spans to start it with, so "make a reel out of what I have selected" is one request. */
    clipIds: z.array(z.string()).max(REEL_ITEM_LIMIT).optional(),
});
export type CreateReelInput = z.infer<typeof createReelSchema>;

export const updateReelSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        visibility: collectionVisibilitySchema.optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });
export type UpdateReelInput = z.infer<typeof updateReelSchema>;

export const reelSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    visibility: collectionVisibilitySchema,
    /** Spans in it, including any whose item this viewer cannot currently reach. */
    itemCount: z.number(),
    /**
     * How long the reel takes to watch: the sum of its spans' **run** times, not their lengths.
     *
     * A twenty-second span at half speed is forty seconds of somebody's evening, so the two
     * differ on exactly the reels somebody took trouble over.
     */
    runningMs: z.number(),
    ownerName: z.string(),
    /** A few covers from across it, for the card. Same reasoning as a playlist's. */
    covers: z.array(z.string()),
    /** Whether this viewer may change it. False for a reel shared by someone else. */
    editable: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Reel = z.infer<typeof reelSchema>;

export const reelSorts = ["updated", "created", "name", "duration", "clipCount"] as const;
export const reelSortSchema = z.enum(reelSorts);
export type ReelSort = z.infer<typeof reelSortSchema>;

const REEL_NATURAL_DIRECTION: Record<ReelSort, SortDirection> = {
    updated: "desc",
    created: "desc",
    name: "asc",
    duration: "desc",
    clipCount: "desc",
};
export const reelNaturalDirection = (sort: ReelSort): SortDirection => REEL_NATURAL_DIRECTION[sort];

/** Whose reels to list. Not two stacked walls: at a few hundred, that stops being readable. */
export const reelOwnerships = ["mine", "shared", "all"] as const;
export const reelOwnershipSchema = z.enum(reelOwnerships);
export type ReelOwnership = z.infer<typeof reelOwnershipSchema>;

export const reelQuerySchema = z.object({
    /**
     * Free text over name and description, matched with `LIKE` and not FTS5.
     *
     * §5c's own argument against a trigram index — it doubles the index for a case prefix search
     * handles — applies with far more force to a few hundred short names than it does to the
     * library, so nothing here earns a second search table.
     */
    search: z.string().trim().max(200).optional(),
    ownership: reelOwnershipSchema.default("all"),
    sort: reelSortSchema.default("updated"),
    direction: sortDirectionSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(48),
    page: z.coerce.number().int().min(0).default(0),
});
export type ReelQuery = z.infer<typeof reelQuerySchema>;

export const reelListResponseSchema = z.object({
    items: z.array(reelSchema),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
    total: z.number(),
});
export type ReelListResponse = z.infer<typeof reelListResponseSchema>;

/**
 * One span at one position, with everything the player needs to open it.
 *
 * No author: by the owner invariant every span in a reel belongs to the person already named on
 * the reel, so saying it per row would be repeating the header once per entry.
 */
export const reelEntrySchema = z.object({
    /** `ReelItem.id`. What `remove` and `move` name, because a clip id may appear twice. */
    id: z.string(),
    position: z.number(),
    clip: clipSchema,
    media: z.object({
        id: z.string(),
        title: z.string(),
        coverUrl: z.string().nullable(),
        durationMs: z.number().nullable(),
        /**
         * Whether the browser can play this file as it stands (§8).
         *
         * Computed server-side, and the reason this endpoint returns entries rather than clip
         * ids. §8b notes `directPlay` lives on the item's detail and not on a list row, which is
         * why stepping through the library fetches the next item's details before warming
         * anything. A reel cannot pay a round trip per span, and without this the player has no
         * way to know which span it may warm and which it must skip.
         */
        directPlay: z.boolean(),
    }),
});
export type ReelEntry = z.infer<typeof reelEntrySchema>;

export const reelItemsResponseSchema = z.object({
    /**
     * The whole reel, in order, never a page.
     *
     * A reel is played in one pass, and paging it would make the player ask a second question
     * part way through — the one moment it must not. That promise is only honest because
     * `REEL_ITEM_LIMIT` bounds the answer.
     */
    items: z.array(reelEntrySchema),
    /** Spans in the reel, including any dropped from `items` for being unreachable. */
    total: z.number(),
    runningMs: z.number(),
});
export type ReelItemsResponse = z.infer<typeof reelItemsResponseSchema>;

export const addReelItemsSchema = z.object({
    clipIds: z.array(z.string()).min(1).max(REEL_ITEM_LIMIT),
});
export type AddReelItemsInput = z.infer<typeof addReelItemsSchema>;

export const moveReelItemSchema = z.object({
    /** A `ReelItem.id`: the same clip may sit at two positions, so a clip id names no row. */
    itemId: z.string(),
    /** Zero-based destination, clamped to the ends rather than rejected. */
    toIndex: z.number().int().min(0),
});
export type MoveReelItemInput = z.infer<typeof moveReelItemSchema>;
