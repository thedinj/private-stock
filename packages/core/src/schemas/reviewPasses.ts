import { z } from "zod";

import { domainKindSchema } from "../libraryDomains.js";

/**
 * Review passes (§14d "Reviewing recordings for a reel").
 *
 * A pass is one person's question about one room's items -- "Players", "Wins" -- and a mark says
 * an item has been through it, and when. Per person, because what somebody is looking for is
 * theirs; per room, because a pass is about one room's kind of content. A handful each, come
 * back to now and then, so nothing here pages.
 */

/** The column's CHECK. A pass is named in a button and in chips, so it stays short. */
export const REVIEW_PASS_NAME_MAX = 60;

/**
 * The pass the single reviewed flag became (2026-11-08), one per person per room.
 *
 * Named here because an old address (`reviewed=yes|no`) is converted to it by the library
 * page, which has the pass list; the migration spells it out for itself.
 */
export const LEGACY_REVIEW_PASS_NAME = "Reviewed";

export const reviewPassNameSchema = z.string().trim().min(1).max(REVIEW_PASS_NAME_MAX);

export const reviewPassSchema = z.object({
    id: z.string(),
    name: z.string(),
    domain: domainKindSchema,
    /** Items marked for it: what deleting the pass would take with it. */
    marks: z.number(),
});
export type ReviewPass = z.infer<typeof reviewPassSchema>;

export const reviewPassListSchema = z.object({ passes: z.array(reviewPassSchema) });
export type ReviewPassList = z.infer<typeof reviewPassListSchema>;

/** Always in the request's room: a pass is made where it is going to be used. */
export const createReviewPassSchema = z.object({ name: reviewPassNameSchema });
export type CreateReviewPassInput = z.infer<typeof createReviewPassSchema>;

export const renameReviewPassSchema = z.object({ name: reviewPassNameSchema });
export type RenameReviewPassInput = z.infer<typeof renameReviewPassSchema>;

/** Marking one item for a pass, or taking the mark back. */
export const setReviewMarkSchema = z.object({
    passId: z.string().min(1).max(64),
    reviewed: z.boolean(),
});
export type SetReviewMarkInput = z.infer<typeof setReviewMarkSchema>;

/** One pass an item has been through, for the chips beside the item page's Review control. */
export const itemReviewSchema = z.object({
    passId: z.string(),
    name: z.string(),
    reviewedAt: z.string(),
});
export type ItemReview = z.infer<typeof itemReviewSchema>;

export const itemReviewsSchema = z.object({ reviews: z.array(itemReviewSchema) });
export type ItemReviews = z.infer<typeof itemReviewsSchema>;
