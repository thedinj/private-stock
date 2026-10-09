import { z } from "zod";

import { facetKindSchema, tagNameSchema, tagScopeSchema } from "./tags.js";
import { allowsPrivate } from "../domain.js";

/**
 * Acting on a selection (§14b).
 *
 * Distinct from bulk tagging (§5d), which takes a *filter* and needs a preview, an exclusion
 * list and a withdrawable batch precisely because nobody can see what a filter matches. This
 * takes an explicit list of ids that somebody ticked. That is the whole difference, and it
 * is why this contract has none of those three things: the preview is the screen.
 *
 * **Select-all takes the page and only the page.** The Gmail pattern — select the page, then
 * offer to extend to all 312 matching — was considered and rejected: it is genuinely more
 * powerful, and the power is pointed at a Trash button. A selection you can see is a
 * selection you can check.
 */

/**
 * The most a selection can hold.
 *
 * The real bound is a page, whose own ceiling is 200 items, and selection is cleared when
 * the view changes — so this is a guard against a crafted request rather than a limit anyone
 * meets. It is deliberately far below `BULK_SELECTION_LIMIT`, which belongs to the
 * filter-shaped operations where nobody has seen the set.
 */
export const BULK_ACTION_LIMIT = 500;

const mediaIds = z.array(z.string()).min(1).max(BULK_ACTION_LIMIT);

/**
 * The most tags the untag dialogue will name.
 *
 * A list somebody cannot see the end of is a tag they cannot remove, so passing it is reported
 * rather than silently trimmed -- the same posture a facet takes when it truncates (§5c). Far
 * above anything a selection of 500 items realistically carries.
 */
export const SELECTION_TAG_LIMIT = 200;

export const bulkActionSchema = z
    .discriminatedUnion("action", [
        /**
         * Add one facet's tags across the selection.
         *
         * Which vocabulary it writes to is not the client's to say: an administrator's tagging
         * is the library's and anybody else's is their own (§6), decided by the service.
         */
        z.object({
            action: z.literal("tag"),
            mediaIds,
            kind: facetKindSchema,
            names: z.array(tagNameSchema).min(1).max(20),
            /** Which tagging system these names are coined and applied in (§6). */
            scope: tagScopeSchema,
        }),
        /**
         * Take tags off the selection.
         *
         * **Ids, not names**, and that is the whole difference. The dialogue lists what the
         * selection actually carries, so the tag is already identified — and an id carries its
         * own facet and its own owner, which is why this arm needs neither `kind` nor `scope`.
         * Asking for a typed name was the shape that let somebody remove nothing: a name that
         * matched no tag was *coined* on the way past, so a misspelt untag added vocabulary
         * instead of taking any away.
         */
        z.object({
            action: z.literal("untag"),
            mediaIds,
            tagIds: z.array(z.string()).min(1).max(SELECTION_TAG_LIMIT),
        }),
        /** `null` clears the rating, which is the only way back to unrated. */
        z.object({
            action: z.literal("rate"),
            mediaIds,
            rating: z.number().int().min(1).max(5).nullable(),
        }),
        z.object({ action: z.literal("favorite"), mediaIds, favorite: z.boolean() }),
        /**
         * Move the originals to the bin.
         *
         * The one destructive verb, and the one whose failures are ordinary rather than
         * exceptional: a selection can span a writable root and a read-only one, and the honest
         * answer is per item rather than an all-or-nothing refusal.
         */
        z.object({ action: z.literal("trash"), mediaIds }),
    ])
    /**
     * Only `tag` can be private (§6).
     *
     * On the union rather than the arm, because `discriminatedUnion` takes objects and a
     * refined arm is no longer one. The other arms pass through untouched.
     */
    .refine(
        (value) => value.action !== "tag" || value.scope === "public" || allowsPrivate(value.kind),
        {
            message: "Only tags can be private — a performer or a source is a fact about the item",
            path: ["scope"],
        }
    );
export type BulkActionInput = z.infer<typeof bulkActionSchema>;

export const bulkActionFailureSchema = z.object({
    mediaId: z.string(),
    /** Plain words, shown to the person who asked. Never an error class name or a stack. */
    reason: z.string(),
});
export type BulkActionFailure = z.infer<typeof bulkActionFailureSchema>;

export const bulkActionResultSchema = z.object({
    /**
     * Items the action actually changed.
     *
     * Not the same as "items it was asked about": re-favouriting something already
     * favourited is a success that changed nothing, and trashing an item already in the bin
     * is a failure. The number is what to say afterwards, so it counts what happened.
     */
    succeeded: z.number(),
    /**
     * What did not work, and why, per item.
     *
     * An array rather than a single message because the interesting case is partial: eleven
     * of fourteen deleted, three on a read-only root. A bulk action that reports only "some
     * of this failed" leaves the person to find out which by inspection.
     */
    failed: z.array(bulkActionFailureSchema),
});
export type BulkActionResult = z.infer<typeof bulkActionResultSchema>;

/**
 * What a ticked selection carries, so untagging can be a choice rather than a spelling test.
 *
 * Nothing in the app could answer this. `getFacets` counts a `MediaQuery` and a selection is a
 * list of ids; the grid's cached tiles hold a truncated two-names-and-a-`+3` (§14b) rather than
 * the whole set. So it is its own read, and it is a POST for the reason `/api/tags/bulk`'s
 * preview is: five hundred ids do not fit in a query string.
 */
export const selectionTagsInputSchema = z.object({ mediaIds });
export type SelectionTagsInput = z.infer<typeof selectionTagsInputSchema>;

export const selectionTagSchema = z.object({
    tagId: z.string(),
    /**
     * Open, like every other `kind` on the wire.
     *
     * A facet a scraper invented is still listed: a tag that cannot be seen is a tag nobody can
     * remove (§5b), and this is the screen removing happens on.
     */
    kind: z.string(),
    name: z.string(),
    colorKey: z.string().nullable(),
    /**
     * Which of the two systems carries it (§6).
     *
     * Derived from the tag's owner and never asked of the client, which is what lets the
     * dialogue offer both at once: the scope is a fact being reported, not a choice being made,
     * so there is no control for somebody to get wrong.
     */
    scope: tagScopeSchema,
    /** Items *in this selection* carrying it — the numerator of "on 12 of 30". */
    count: z.number(),
});
export type SelectionTag = z.infer<typeof selectionTagSchema>;

export const selectionTagsResponseSchema = z.object({
    tags: z.array(selectionTagSchema),
    /**
     * Items the viewer can actually see, and the denominator of every count above.
     *
     * Not the number of ids asked about: an id on a library this account was never granted is
     * in no count, and "on 12 of 30" against a thirty that includes items nobody counted is a
     * wrong number presented as an exact one.
     */
    selected: z.number(),
    truncated: z.boolean(),
});
export type SelectionTagsResponse = z.infer<typeof selectionTagsResponseSchema>;
