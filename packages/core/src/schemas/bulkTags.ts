import { z } from "zod";

import { PRIVATE_FACET_MESSAGE, facetKindSchema, scopeFitsFacet, tagScopeSchema } from "./tags.js";

import { BULK_SELECTION_LIMIT, savedQuerySchema } from "./filters.js";

/**
 * Tagging a filtered set in one action (§5d).
 *
 * The filter is an approximation of intent, so this contract carries three things the design
 * insists on: a preview of how many items are affected before anything is written, per-item
 * exclusions to correct the filter's overreach, and a batch id that makes the whole thing
 * withdrawable afterwards.
 */

export const bulkTagPreviewSchema = z.object({
    query: savedQuerySchema,
    /**
     * The saved filter the grid was opened from, if any (§6).
     *
     * Only so the server can resolve a shared filter against its owner's ratings the way the
     * grid and its count did -- otherwise the dialogue could tag a different set from the one
     * on screen. The server decides whether it applies; naming a filter grants nothing.
     */
    filterId: z.string().max(100).nullish(),
    excludeIds: z.array(z.string()).max(BULK_SELECTION_LIMIT).default([]),
});
export type BulkTagPreviewInput = z.infer<typeof bulkTagPreviewSchema>;

export const bulkTagPreviewResultSchema = z.object({
    /** Items the filter matches, before exclusions. */
    matched: z.number(),
    /** Items that would actually be tagged. */
    affected: z.number(),
    /** True when the filter matches more than one action may touch — nothing will be written. */
    overLimit: z.boolean(),
    limit: z.number(),
});
export type BulkTagPreviewResult = z.infer<typeof bulkTagPreviewResultSchema>;

export const bulkTagApplySchema = bulkTagPreviewSchema
    .extend({
        // The same facet rule `createTagSchema` applies. It was a bare string, so this route could
        // coin a facet the tag editor would reject -- one that never appears in a box again.
        kind: facetKindSchema,
        names: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
        /**
         * Which tagging system this apply writes into (§6).
         *
         * The highest-stakes place this field appears: an apply reaches `BULK_SELECTION_LIMIT`
         * items, so getting it wrong publishes ten thousand assignments in one gesture. Required
         * like everywhere else, and the confirmation says which system it names.
         */
        scope: tagScopeSchema,
        /**
         * What the caller believed it was about to affect.
         *
         * Sent back so the server can refuse if the library moved under the preview — a filter on
         * "added this week" means something different ten minutes later, and an apply that
         * silently tagged more than the number the person agreed to is precisely the accident
         * this feature has to make impossible.
         */
        expectedCount: z.number().int().min(0),
    })
    .refine(scopeFitsFacet, { message: PRIVATE_FACET_MESSAGE, path: ["scope"] });
export type BulkTagApplyInput = z.infer<typeof bulkTagApplySchema>;

export const tagBatchSchema = z.object({
    id: z.string(),
    /** What was done, in the words that were true when it happened. */
    summary: z.string(),
    mediaCount: z.number(),
    /** Clips tagged, for a batch of clips (§14d); null for a batch of items. */
    clipCount: z.number().nullable(),
    createdAt: z.string(),
    undoneAt: z.string().nullable(),
});
export type TagBatch = z.infer<typeof tagBatchSchema>;

export const bulkTagResultSchema = z.object({
    batch: tagBatchSchema,
    /** Assignments written. Lower than `mediaCount` when items already carried the tag. */
    assigned: z.number(),
});
export type BulkTagResult = z.infer<typeof bulkTagResultSchema>;
