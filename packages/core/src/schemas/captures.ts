import { z } from "zod";

import { sortDirectionSchema, type SortDirection } from "../domain.js";
import { mediaFrameSchema } from "./media.js";

/**
 * The Captures page's contracts (§9 "Your captures, in one place").
 *
 * A capture is library-wide to read, but this page lists **your own**: the question it answers
 * is "what have I grabbed", the same one `/clips` answers for spans. Everybody's captures stay
 * on each item's strip.
 *
 * A capture here is a `MediaFrame` plus the item it came from, so the frame lightbox takes a
 * page of these without an adapter.
 */

export const captureSchema = mediaFrameSchema.extend({
    mediaId: z.string(),
    mediaTitle: z.string(),
});
export type Capture = z.infer<typeof captureSchema>;

export const captureSorts = ["created", "title", "position"] as const;
export const captureSortSchema = z.enum(captureSorts);
export type CaptureSort = z.infer<typeof captureSortSchema>;

/** Exhaustive, so a new sort without a decided direction is a compile error. */
const CAPTURE_NATURAL_DIRECTION: Record<CaptureSort, SortDirection> = {
    created: "desc",
    title: "asc",
    position: "asc",
};
export const captureNaturalDirection = (sort: CaptureSort): SortDirection =>
    CAPTURE_NATURAL_DIRECTION[sort];

export const captureQuerySchema = z.object({
    /** Free text over the caption and the item's title. */
    search: z.string().trim().max(200).optional(),
    sort: captureSortSchema.default("created"),
    direction: sortDirectionSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
    page: z.coerce.number().int().min(0).default(0),
});
export type CaptureQuery = z.infer<typeof captureQuerySchema>;

export const captureListResponseSchema = z.object({
    items: z.array(captureSchema),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
    total: z.number(),
});
export type CaptureListResponse = z.infer<typeof captureListResponseSchema>;

/** Write or clear a capture's caption. An empty string clears, the same as `null`. */
export const updateCaptureSchema = z.object({
    label: z.string().trim().max(200).nullable(),
});
export type UpdateCaptureInput = z.infer<typeof updateCaptureSchema>;

/**
 * The most captures one discard may name. A bound on a single request's work, not a
 * statement about how many anybody should have; the page selects at most a few pages' worth.
 */
export const CAPTURE_DISCARD_LIMIT = 500;

export const discardCapturesSchema = z.object({
    artifactIds: z.array(z.string()).min(1).max(CAPTURE_DISCARD_LIMIT),
});
export type DiscardCapturesInput = z.infer<typeof discardCapturesSchema>;

/**
 * What a discard did, per capture rather than all-or-nothing.
 *
 * A selection can go stale while it is held — a capture discarded from the item page, an item
 * trashed — and one stale id must not refuse the other forty.
 */
export const discardCapturesResultSchema = z.object({
    succeeded: z.number(),
    failed: z.array(z.object({ artifactId: z.string(), reason: z.string() })),
});
export type DiscardCapturesResult = z.infer<typeof discardCapturesResultSchema>;
